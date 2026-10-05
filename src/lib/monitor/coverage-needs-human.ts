import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";
import { parseStampMs } from "@/lib/date/stamp";
import type { BulkReassignJobStatus } from "@/lib/db/types";
import { log } from "@/lib/log";

/**
 * Appointments a coverage sweep gave up on (#1242).
 *
 * When the bulk sweep cannot place one, it settles the item as `unplaceable`
 * (nobody was free and under their daily cap at that time) or, after exhausting
 * its retries, `failed`. Both are terminal, and both mean the appointment is still
 * assigned to an agent who is not going to be there, with only a person able to
 * resolve it. Until this check existed the outcome reached exactly two places: the
 * admin coverage panel on the agent's page, and a count in the drain lane's log
 * line. So "this needs a human" depended on a human already looking, which was
 * survivable while an admin was watching the panel they had just started, and not
 * survivable once approvals and offboarding enqueue sweeps with nobody present.
 *
 * The complement of this check is #1238, and the boundary matters: this one sees
 * the give-ups the sweep RECORDED. A gap the sweep never knew about (an approval
 * where no sweep was enqueued at all, or one that died mid-flight) leaves no row
 * here and needs its own read.
 *
 * What a page counts (#3303). On 2026-10-05 it said 1 appointment and the truth was
 * 4, through four separate faults: it counted the first give up of three sweeps
 * that were still running, its cooldown then hid the rest, it counted items rather
 * than calls (two sweeps over one day give up on the same call twice), and it never
 * re-checked that a call was still with the agent the sweep was moving it off. So a
 * page now carries every call stranded by every sweep that has FINISHED
 * (`countStranded`), counted once per booking and only while the booking is still
 * with the sweep's out agent, and a call that becomes countable after a page
 * re-pages at once rather than waiting out the cooldown (`PageNews`).
 */

/** alert_state row key for the throttle. Lives with the feature so the cron lane
 *  and the settings screen refer to the one constant. */
export const COVERAGE_NEEDS_HUMAN_KEY = "coverage_needs_human";

/** The two terminal outcomes that mean a person has to act. Mirrors
 *  `ACTIONABLE_ITEM_STATUSES` in the engine, which is what the admin panel lists,
 *  so the page and the panel can never disagree about what counts (L16). */
export type StrandedStatus = "unplaceable" | "failed";

/** One appointment the sweep could not move, as read from the item worklist. */
export interface StrandedAppointment {
  bookingId: string;
  /** The agent it is still assigned to: the sweep's out agent. */
  outUserId: string;
  status: StrandedStatus;
}

/**
 * One give up as the loader read it: the item, the sweep it belongs to, and where
 * the booking is NOW. Carries the stamps as stored, so the rule for what they mean
 * lives in `countStranded`, where tests can reach it.
 */
export interface StrandedItemRead {
  bookingId: string;
  status: StrandedStatus;
  /** The item's `updated_at`: when the sweep settled it. */
  settledAt: string;
  sweep: {
    /** The agent the sweep was moving appointments off. */
    outUserId: string;
    /** `active` until every item has an outcome; `done` or `cancelled` after. */
    status: BulkReassignJobStatus;
    /** The sweep's `updated_at`, which for a finished sweep is when it finished. */
    updatedAt: string;
  };
  /** Who holds the booking now, or null when it is no longer active and upcoming. */
  assignedUserId: string | null;
}

/**
 * How long a give up from a sweep that has NOT finished waits before it is counted
 * anyway (#3303), measured from when the item settled.
 *
 * A page counts what FINISHED sweeps gave up on, because a sweep still running has
 * more items to settle and a count taken part way is wrong by the time anyone reads
 * it. But a sweep that stalls never finishes, and its give ups must not be held
 * back for ever (L98), so past this bound they count while it is still running.
 *
 * Why 30 minutes. The three sweeps measured on 2026-10-05 took 3m57s, 4m31s and
 * 5m34s from creation to done, most of it waiting for the drain lane's next
 * five-minute tick; the drain takes up to 20 items a tick, so each further 20
 * items adds one tick. 30 minutes is more than five times the longest of them and
 * six drain ticks after the item settled, so a healthy sweep of up to about a
 * hundred appointments still finishes inside it. It is also longer than the 20 minutes
 * after which the lane watchdog pages a silent drain lane (`LANE_STALE_BOUNDS_MS`),
 * so a drain that has died is reported by its own page first.
 *
 * Wrong one way, a sweep larger than that pages a count that later grows, and each
 * growth re-pages: noisier, never wrong about any call it names. Wrong the other
 * way, a stalled sweep's give ups reach a person later. The first is the safer.
 */
export const SWEEP_FINISH_WAIT_MS = 30 * 60_000;

/** What `countStranded` found: the calls to page about, and the ones held back. */
export interface CountedStranded {
  /** One per distinct booking, each still with its sweep's out agent. */
  appointments: StrandedAppointment[];
  /** Distinct bookings given up on by a sweep still running, not yet counted. */
  waiting: number;
  /** The newest moment any counted appointment became countable; null when none is known. */
  newestCountableMs: number | null;
}

/**
 * When one give up became countable, as of `asOfMs`, or `false` while it is still
 * held back. `null` is countable with no known moment: a stamp that cannot be read.
 *
 * A finished sweep's give up became countable when the SWEEP finished, not when the
 * item settled: dating it by the item would put it before a page sent between the
 * two, and a sweep finishing just after a page would never read as news. The bound
 * can make it countable earlier than that, so the earlier of the two wins.
 */
function countableAt(it: StrandedItemRead, asOfMs: number): number | null | false {
  const settledMs = parseStampMs(it.settledAt);
  const boundMs = settledMs === null ? null : settledMs + SWEEP_FINISH_WAIT_MS;
  if (it.sweep.status !== "active") {
    const finishedMs = parseStampMs(it.sweep.updatedAt);
    // Read as finished, but after the measurement began: count it next tick, so it
    // lands on exactly one page rather than this one and then again as news.
    if (finishedMs !== null && finishedMs > asOfMs && (boundMs === null || boundMs > asOfMs)) return false;
    const known = [finishedMs, boundMs].filter((m): m is number => m !== null && m <= asOfMs);
    // A customer is never dropped for a bookkeeping reason: an unreadable stamp
    // still counts, it just cannot be news.
    return known.length > 0 ? Math.min(...known) : null;
  }
  if (boundMs === null) return null;
  return boundMs <= asOfMs ? boundMs : false;
}

/**
 * Which give ups a page may count, as of `asOfMs` (#3303). Pure, so each rule is
 * pinned by a test rather than living in a query nothing can assert against.
 *
 * - Only a call still assigned to the sweep's out agent counts. A call moved by
 *   any route that does not write the item back is not stranded (L200).
 * - Only a sweep that has finished counts, or a give up that has waited
 *   `SWEEP_FINISH_WAIT_MS` in one that has not. Everything else is `waiting`.
 * - One booking is one appointment however many sweeps gave up on it. It became
 *   countable at the EARLIEST of its give ups, so a second sweep over the same day
 *   is not news about a call the reader was already told about, and it carries the
 *   outcome of its most recent attempt.
 *
 * `asOfMs` must be taken BEFORE the reads, so a fact that lands while they run is
 * left for the next tick and reads as news there.
 */
export function countStranded(items: StrandedItemRead[], asOfMs: number): CountedStranded {
  const counted = new Map<string, { appt: StrandedAppointment; atMs: number | null; settledMs: number }>();
  const held = new Set<string>();
  for (const it of items) {
    if (it.assignedUserId === null || it.assignedUserId !== it.sweep.outUserId) continue;
    const at = countableAt(it, asOfMs);
    if (at === false) {
      held.add(it.bookingId);
      continue;
    }
    const settledMs = parseStampMs(it.settledAt) ?? Number.NEGATIVE_INFINITY;
    const appt: StrandedAppointment = { bookingId: it.bookingId, outUserId: it.sweep.outUserId, status: it.status };
    const prior = counted.get(it.bookingId);
    if (!prior) {
      counted.set(it.bookingId, { appt, atMs: at, settledMs });
      continue;
    }
    const known = [prior.atMs, at].filter((m): m is number => m !== null);
    counted.set(it.bookingId, {
      appt: settledMs > prior.settledMs ? appt : prior.appt,
      atMs: known.length > 0 ? Math.min(...known) : null,
      settledMs: Math.max(settledMs, prior.settledMs),
    });
  }
  let newest: number | null = null;
  for (const c of counted.values()) {
    if (c.atMs !== null && (newest === null || c.atMs > newest)) newest = c.atMs;
  }
  return {
    appointments: [...counted.values()].map((c) => c.appt),
    waiting: [...held].filter((id) => !counted.has(id)).length,
    newestCountableMs: newest,
  };
}

/** Display context for an out agent, so the page names a person not a uuid. */
export interface CoverageOutAgent {
  id: string;
  name: string | null;
  email: string | null;
}

/** One agent still holding appointments a sweep could not move. */
export interface StrandedHolder {
  userId: string;
  name: string | null;
  email: string | null;
  /** Nobody was free and under cap at the original time. */
  unplaceable: number;
  /** The move itself kept erroring until it ran out of attempts. */
  failed: number;
}

/**
 * Group the stranded items by the agent they are stuck on. Pure, so the rule for
 * what counts is pinned by tests rather than living inside a query nothing can
 * assert against.
 *
 * The two outcomes stay SEPARATE rather than collapsing into one total, because
 * they need different remediation: nobody being free may only need a different
 * time or a deliberate over-cap override, whereas a move that kept erroring is
 * usually something systemic that will happen again to the next one.
 *
 * An agent missing from the roster read is still reported, keyed by id. A stranded
 * customer must never be dropped for a bookkeeping reason, which is the failure
 * mode where the count quietly disagrees with reality.
 *
 * Ordered worst-holder-first so a truncated list in the alert names the biggest
 * gap rather than an arbitrary one.
 *
 * Counts BOOKINGS, not items (#3303): a day swept twice has two items per call,
 * and counting items read the active agent's 2 calls as 4. `countStranded` already
 * hands over one per booking; this holds the same line for any other caller, and
 * keeps the first it sees.
 */
export function strandedHoldersFromItems(
  items: StrandedAppointment[],
  agents: CoverageOutAgent[],
): StrandedHolder[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const holders = new Map<string, StrandedHolder>();
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.bookingId)) continue;
    seen.add(it.bookingId);
    let h = holders.get(it.outUserId);
    if (!h) {
      const agent = byId.get(it.outUserId);
      h = {
        userId: it.outUserId,
        name: agent?.name ?? null,
        email: agent?.email ?? null,
        unplaceable: 0,
        failed: 0,
      };
      holders.set(it.outUserId, h);
    }
    if (it.status === "failed") h.failed++;
    else h.unplaceable++;
  }
  const total = (h: StrandedHolder) => h.unplaceable + h.failed;
  return [...holders.values()].sort(
    (x, y) => total(y) - total(x) || x.userId.localeCompare(y.userId),
  );
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post rather than a wall of names.
const NAME_CAP = 8;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Who the agent is, preferring a name and never rendering a placeholder. */
const whoIs = (h: StrandedHolder): string => {
  const who = h.name?.trim() || h.email || h.userId;
  return h.email && h.email !== who ? `${who} (${h.email})` : who;
};

/** Human line for one holder: who, how many, and which outcome, since the
 *  remediation differs per outcome. */
function holderLine(h: StrandedHolder): string {
  const parts: string[] = [];
  if (h.unplaceable > 0) {
    parts.push(`${plural(h.unplaceable, "appointment", "appointments")} nobody was free for`);
  }
  if (h.failed > 0) {
    parts.push(`${plural(h.failed, "appointment", "appointments")} where the move kept failing`);
  }
  return `${whoIs(h)}, ${parts.join(", ")}`;
}

/**
 * The page. States the customer-facing consequence first, because that is what
 * decides whether someone acts at 7am, then names the agents and which outcome
 * they hit, then points at the ONE place that fixes it. Deliberately carries no
 * booking ids or times: the coverage panel lists them and a page is read on a
 * phone.
 *
 * Verbs agree with the subject in both directions. Counting the nouns is not
 * enough, which is only visible rendered (`pnpm preview:alerts`).
 */
export function formatCoverageNeedsHumanAlert(holders: StrandedHolder[]): string {
  const total = holders.reduce((n, h) => n + h.unplaceable + h.failed, 0);
  const one = total === 1;
  const oneAgent = holders.length === 1;
  const lines = holders.slice(0, NAME_CAP).map(holderLine);
  const more = holders.length > NAME_CAP ? `\n(and ${holders.length - NAME_CAP} more)` : "";
  return (
    `${plural(total, "appointment", "appointments")} could not be moved to another advisor and ` +
    `${one ? "is" : "are"} still with ` +
    `${oneAgent ? "an agent who will not be there" : "agents who will not be there"}. ` +
    `${one ? "That customer" : "Those customers"} will meet nobody unless someone moves ` +
    `${one ? "it" : "them"} by hand. Reassign ` +
    `${one ? "it" : "them"} from the agent's page in Admin, under ${COVERAGE_PANEL_NAME}.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all-clear. Says the customers are covered again, and deliberately does NOT
 * repeat the page's remediation: the reader is being told to stand down, and
 * carrying "reassign them from the coverage panel" into a recovery notice is how
 * someone gets sent to redo work that is already done.
 */
export function formatCoverageNeedsHumanRecovery(): string {
  return (
    `Every appointment a coverage sweep could not move has since been placed or has passed. ` +
    `No customer is left holding an appointment with an agent who will not be there, so no ` +
    `action is needed.`
  );
}

/**
 * What the loader hands the check: the holders `countStranded` counted, how many
 * calls are still held back, and what the dispatcher needs to tell news apart.
 */
export interface StrandedRead {
  holders: StrandedHolder[];
  /** Calls a sweep still running gave up on, not yet counted (`countStranded`). */
  waiting: number;
  /** The newest moment any counted appointment became countable; null when none is known. */
  newestCountableMs: number | null;
  /** Taken before the reads began, so anything landing during them reads as news next tick. */
  asOfMs: number;
}

/**
 * What one tick measured. `unreadable` is NOT zero, and neither is `waiting`: see
 * the check below.
 */
export interface CoverageNeedsHumanResult {
  status: "clear" | "stranded" | "waiting" | "unreadable";
  agents: number;
  appointments: number;
  /** Calls held back because the sweep that gave up on them is still running. */
  waiting: number;
}

/**
 * One monitor tick: measure what the sweep gave up on, page when there is
 * anything, and clear when a real read says there is not.
 *
 * There is deliberately NO streak here, unlike `inactive_agent_bookings`. That
 * check needs one because an admin deactivating an agent and then running the
 * coverage panel a minute later is an ordinary, correct sequence that briefly
 * looks identical to a real gap. This one is different in kind: a give up from a
 * FINISHED sweep is terminal, assigned only after the engine has tried, so the
 * condition is already settled the moment it is observed and waiting would only
 * delay telling someone. What a sweep still running gave up on is held back by
 * `countStranded`, and an item still being worked is `pending` and is not read at
 * all.
 *
 * The four states are distinct, and the last two are the ones this class of
 * defect keeps shipping without:
 *
 *   - stranded: page, throttled by the cooldown unless it carries a call that
 *     became countable after the last delivered page (#3303), which goes out at
 *     once so the reader is never left acting on a count that has grown.
 *   - a MEASURED zero: announce recovery. `resolveAlert` is a no-op unless a page
 *     was actually delivered, so a check that never alerted stays silent.
 *   - waiting: nothing countable yet, but a sweep still running has given up on a
 *     call. Do neither: the count is not finished, so it is not a zero, and "no
 *     customer is left holding an appointment" would be false (#1152).
 *   - a read that FAILED: do neither. An unread worklist comes back empty, and an
 *     empty result here is indistinguishable from "nothing is stranded", so
 *     announcing recovery off it would clear a real page at the moment the system
 *     is least able to tell anyone (#1134, #1152).
 *
 * Best-effort by design: monitoring must never take down the lane it watches, so
 * both dispatches are caught.
 */
export async function runCoverageNeedsHumanCheck(deps: {
  loadStranded: () => Promise<StrandedRead>;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<CoverageNeedsHumanResult> {
  let read: StrandedRead;
  try {
    read = await deps.loadStranded();
  } catch (err) {
    // Fail loud in the logs, silent on the alert channels. The lane heartbeat
    // covers a database that cannot be read at all; what must not happen is this
    // check turning an unread result into an all-clear.
    log.error("coverage-needs-human", { msg: "stranded read failed" }, err);
    deps.log?.({ status: "unreadable" });
    return { status: "unreadable", agents: 0, appointments: 0, waiting: 0 };
  }

  const { holders, waiting } = read;
  const appointments = holders.reduce((n, h) => n + h.unplaceable + h.failed, 0);

  if (holders.length === 0 && waiting > 0) {
    deps.log?.({ status: "waiting", agents: 0, appointments: 0, waiting });
    return { status: "waiting", agents: 0, appointments: 0, waiting };
  }

  if (holders.length === 0) {
    // alert-key: coverage_needs_human
    await resolveAlert(COVERAGE_NEEDS_HUMAN_KEY, formatCoverageNeedsHumanRecovery()).catch(logResolveFailure(COVERAGE_NEEDS_HUMAN_KEY));
    deps.log?.({ status: "clear", agents: 0, appointments: 0, waiting: 0 });
    return { status: "clear", agents: 0, appointments: 0, waiting: 0 };
  }

  // alert-key: coverage_needs_human
  await sendThrottledAlert(
    COVERAGE_NEEDS_HUMAN_KEY,
    deps.cooldownMs,
    formatCoverageNeedsHumanAlert(holders),
    undefined,
    { newestMs: read.newestCountableMs, asOfMs: read.asOfMs },
  ).catch(logAlertSendFailure(COVERAGE_NEEDS_HUMAN_KEY));
  deps.log?.({ status: "stranded", agents: holders.length, appointments, waiting });
  return { status: "stranded", agents: holders.length, appointments, waiting };
}
