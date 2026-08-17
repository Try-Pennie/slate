import { movesUnderCoverage } from "@/lib/booking/coverage-selection";
import { parseStampMs } from "@/lib/date/stamp";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, sendThrottledInfo, resolveAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/**
 * An agent on APPROVED time off still holding an appointment inside that window (#1238).
 *
 * Approving time off blocks the agent's calendar and enqueues a coverage sweep, so the ordinary
 * path already moves the appointments they hold. This is the safety net for the paths that leave
 * no trace: an approval whose sweep never ran (a Worker that died mid-approval, a coverage effect
 * recorded as failed that nobody retried), a retroactive approval where the window was already
 * under way, and a booking made into a window that had already been approved. In every one of
 * those the customer keeps a confirmed appointment with an advisor who is definitely not going
 * to be there, and nothing anywhere says so.
 *
 * **The boundary with #1242, which matters.** That check owns the give-ups the sweep RECORDED:
 * an item settled `unplaceable` or `failed` whose booking is still upcoming. This one owns the
 * appointments with no `bulk_reassign_items` row at all. They are deliberately disjoint: two
 * signals about one appointment would eventually disagree about it, and a reader holding both
 * cannot tell which to act on. So a snapshotted booking is #1242's, whatever came of it, and
 * this check says nothing about it.
 *
 * **Two narrowings, so it cannot cry wolf** (L36). Leftovers are an ordinary property of a busy
 * roster, and a check that re-pages forever about one is a check people learn to ignore:
 *
 *   - only appointments starting within `OOO_GAP_IMMINENT_HOURS` page. Acting today changes the
 *     outcome for those. The rest are real and are whispered once a day instead, which is a
 *     different urgency and therefore a different channel (L112 in reverse: the urgency is set
 *     by what the reader must do and how soon).
 *   - an agent whose coverage sweep is still draining is not reported at all. That suppression
 *     is bounded and observed rather than hopeful: the engine flips a job to `done` only at zero
 *     pending, an item that keeps erroring is converted to `failed` (which #1242 pages on), and
 *     a drain lane that stops entirely goes stale in the lane watchdog at 20 minutes. So
 *     "still draining" cannot quietly become permanent silence (L106).
 *
 * The predicate is NOT re-derived here. `movesUnderCoverage` is the one rule for "does this
 * appointment need covering", shared with the SQL bounds the sweep selects with, so this check
 * and the sweep cannot come to mean different things by it (L16). That is not a tidiness point:
 * the case this check exists for includes the straddler that begins before the window and runs
 * into it, and a second hand-rolled overlap test is exactly how the check written to catch that
 * miss would repeat it.
 */

/** alert_state row key for the page. Lives with the feature so the cron lane and the settings
 *  screen refer to the one constant. */
export const OOO_COVERAGE_GAP_KEY = "ooo_coverage_gap";

/** A SEPARATE key for the daily whisper about the further-out ones. Two independent conditions
 *  must never share one status row: a pass from one would erase the other's failure and the
 *  streak that was about to fire (L53). */
export const OOO_COVERAGE_GAP_LATER_KEY = "ooo_coverage_gap_later";

/**
 * How soon an appointment has to be before it pages.
 *
 * 48 hours is where acting changes the outcome: there is time to place it with a covering agent
 * and tell the customer before the day itself. Beyond that the coverage panel and the daily
 * whisper are the right surfaces, because a page nobody needs to act on tonight is the page that
 * teaches everyone to swipe them away.
 */
export const OOO_GAP_IMMINENT_HOURS = 48;

/**
 * Consecutive monitor ticks holding an imminent gap before this pages. The monitor lane runs
 * every 5 minutes, so 3 ticks is about 15 minutes.
 *
 * Much shorter than the hour its #1215 sibling waits, and deliberately: that one watches a state
 * an admin routinely creates on purpose for a few minutes (deactivate, then run the coverage
 * panel). There is no ordinary, correct sequence that leaves an approved absence holding an
 * unsnapshotted appointment, because the sweep is enqueued inside the approval itself. The
 * streak is here for the moments BETWEEN the approval's writes, not for a legitimate steady
 * state, so it only has to outlast one of them.
 */
export const OOO_GAP_ALERT_AFTER_TICKS = 3;

/** Streak window. Must comfortably exceed 3 ticks * 5 min so genuinely consecutive ticks land in
 *  the same window, with slack for a delayed tick. */
export const OOO_GAP_WINDOW_SECONDS = 60 * 60;

/** Once a day. The further-out gaps are a worklist, not an incident, and a worklist that
 *  arrives hourly is noise. */
export const OOO_GAP_WHISPER_COOLDOWN_MS = 24 * 60 * 60_000;

/** An approved, live absence window. */
export interface OooAbsence {
  requestId: string;
  userId: string;
  startIso: string;
  endIso: string;
}

/** One active upcoming booking assigned to an agent who has an approved absence. */
export interface AbsentAgentBooking {
  bookingId: string;
  assignedUserId: string;
  startsAtIso: string;
  endsAtIso: string;
  /** True when a `bulk_reassign_items` row exists for it, whatever its status: then it is
   *  #1242's to report, not this check's. */
  snapshotted: boolean;
}

/** Display context for an absent agent, so a message names a person not a uuid. */
export interface CoverageGapAgent {
  id: string;
  name: string | null;
  email: string | null;
}

/** One agent holding appointments inside their own approved absence. */
export interface OooGapHolder {
  userId: string;
  name: string | null;
  email: string | null;
  /** Starting within `OOO_GAP_IMMINENT_HOURS`. These page. */
  imminent: number;
  /** Further out. These whisper once a day. */
  later: number;
  /** The soonest uncovered start, so a message can say how long there is to act. */
  soonestStartIso: string;
}

/**
 * Group the uncovered appointments by the agent who is away.
 *
 * Pure, so the rule for what counts is pinned by tests rather than living inside a query nothing
 * can assert against, and so the imminent / later split is one decision in one place rather than
 * a threshold copied into two messages.
 *
 * An agent missing from the roster read is still reported, keyed by id. A customer with nobody
 * to meet must never be dropped for a bookkeeping reason: that is the failure mode where the
 * count quietly disagrees with reality.
 *
 * Ordered worst-holder-first so a truncated list names the biggest gap rather than an arbitrary
 * one.
 */
export function oooCoverageHolders(input: {
  absences: OooAbsence[];
  bookings: AbsentAgentBooking[];
  agents: CoverageGapAgent[];
  /** Agents with an ACTIVE coverage job: their sweep is still working. */
  sweepingUserIds: string[];
  nowIso: string;
}): OooGapHolder[] {
  const { absences, bookings, agents, sweepingUserIds, nowIso } = input;
  const sweeping = new Set(sweepingUserIds);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const windowsByUser = new Map<string, OooAbsence[]>();
  for (const a of absences) {
    const list = windowsByUser.get(a.userId);
    if (list) list.push(a);
    else windowsByUser.set(a.userId, [a]);
  }

  const nowMs = parseStampMs(nowIso);
  const imminentUntilMs =
    nowMs === null ? null : nowMs + OOO_GAP_IMMINENT_HOURS * 60 * 60_000;

  const holders = new Map<string, OooGapHolder>();
  for (const b of bookings) {
    if (b.snapshotted) continue;
    if (sweeping.has(b.assignedUserId)) continue;
    const windows = windowsByUser.get(b.assignedUserId);
    if (!windows) continue;
    // ANY of the agent's approved windows covering it is enough, and one appointment counts
    // once however many cover it: two overlapping approvals are one absence to the customer.
    const covered = windows.some((w) =>
      movesUnderCoverage(
        { startsAtIso: b.startsAtIso, endsAtIso: b.endsAtIso },
        { startIso: w.startIso, endIso: w.endIso },
        nowIso,
      ),
    );
    if (!covered) continue;

    const startsMs = parseStampMs(b.startsAtIso);
    // Unreachable from the database (`starts_at` is NOT NULL timestamptz) and unreachable past
    // the predicate above, which already answers no on an unreadable stamp. Kept because a
    // silent NaN comparison here would decide the channel, and "later" is the quieter side.
    if (startsMs === null || imminentUntilMs === null) continue;
    const isImminent = startsMs <= imminentUntilMs;

    const existing = holders.get(b.assignedUserId);
    if (existing) {
      if (isImminent) existing.imminent += 1;
      else existing.later += 1;
      if (startsMs < (parseStampMs(existing.soonestStartIso) ?? Infinity)) {
        existing.soonestStartIso = b.startsAtIso;
      }
      continue;
    }
    const agent = byId.get(b.assignedUserId);
    holders.set(b.assignedUserId, {
      userId: b.assignedUserId,
      name: agent?.name ?? null,
      email: agent?.email ?? null,
      imminent: isImminent ? 1 : 0,
      later: isImminent ? 0 : 1,
      soonestStartIso: b.startsAtIso,
    });
  }

  return [...holders.values()].sort(
    (x, y) =>
      y.imminent - x.imminent || y.later - x.later || x.userId.localeCompare(y.userId),
  );
}

// Match the other monitor notices' list cap so a broad gap stays one readable Slack post rather
// than a wall of names.
const NAME_CAP = 8;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Who they are and how much they are holding, so the reader can triage without opening the
 *  admin. */
function holderLine(h: OooGapHolder, count: (h: OooGapHolder) => number): string {
  const who = h.name?.trim() || h.email || h.userId;
  const contact = h.email && h.email !== who ? `${who} (${h.email})` : who;
  return `${contact}, ${plural(count(h), "appointment", "appointments")}`;
}

const imminentOf = (h: OooGapHolder) => h.imminent;
const laterOf = (h: OooGapHolder) => h.later;

/**
 * The page. States the customer-facing consequence first, because that is what decides whether
 * somebody acts at 7am, then names the agents, then points at the ONE place that fixes it.
 *
 * The verbs agree with the subject in both directions. Counting the nouns is not enough:
 * "1 agent who ARE away still HOLD 1 appointment" satisfies every singular and plural assertion
 * about "agent" and "appointment" and still reads wrong, which is only visible rendered
 * (`pnpm preview:alerts`).
 */
export function formatOooCoverageGapAlert(holders: OooGapHolder[]): string {
  const withImminent = holders.filter((h) => h.imminent > 0);
  const total = withImminent.reduce((n, h) => n + h.imminent, 0);
  const oneAgent = withImminent.length === 1;
  const oneBooking = total === 1;
  const lines = withImminent.slice(0, NAME_CAP).map((h) => holderLine(h, imminentOf));
  const more =
    withImminent.length > NAME_CAP ? `\n(and ${withImminent.length - NAME_CAP} more)` : "";
  return (
    `${plural(withImminent.length, "agent", "agents")} on approved time off still ` +
    `${oneAgent ? "holds" : "hold"} ${plural(total, "appointment", "appointments")} ` +
    `starting within ${OOO_GAP_IMMINENT_HOURS} hours. No coverage sweep has picked ` +
    `${oneBooking ? "it" : "them"} up, so ` +
    `${oneBooking ? "that customer" : "those customers"} will meet nobody unless ` +
    `${oneBooking ? "it is" : "they are"} moved. Reassign ` +
    `${oneBooking ? "it" : "them"} from the agent's page in Admin, under Coverage.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all-clear. Says the customers are covered again, and deliberately does NOT repeat the
 * page's remediation: the reader is being told to stand down, and carrying "reassign them" into
 * a recovery notice is how an all-clear sends somebody to redo work that is already done.
 */
export function formatOooCoverageGapRecovery(): string {
  return (
    `No agent on approved time off is holding an appointment in the next ` +
    `${OOO_GAP_IMMINENT_HOURS} hours any more. The appointments behind the earlier page have ` +
    `been covered or have passed. No action is needed.`
  );
}

/**
 * The whisper, for the gaps that are real but not urgent. Its own words, not a quieter copy of
 * the page: it has to say what it is NOT, or a reader who has seen the page reads this as one
 * and goes looking for something to do tonight.
 */
export function formatOooCoverageGapWhisper(holders: OooGapHolder[]): string {
  const withLater = holders.filter((h) => h.later > 0);
  const total = withLater.reduce((n, h) => n + h.later, 0);
  const oneAgent = withLater.length === 1;
  const lines = withLater.slice(0, NAME_CAP).map((h) => holderLine(h, laterOf));
  const more = withLater.length > NAME_CAP ? `\n(and ${withLater.length - NAME_CAP} more)` : "";
  return (
    `${plural(withLater.length, "agent", "agents")} on approved time off still ` +
    `${oneAgent ? "holds" : "hold"} ${plural(total, "appointment", "appointments")} ` +
    `more than ${OOO_GAP_IMMINENT_HOURS} hours out, with no coverage sweep on ` +
    `${total === 1 ? "it" : "them"}. There is time to place ` +
    `${total === 1 ? "it" : "them"} from the agent's page in Admin, under Coverage; nothing ` +
    `needs doing today.\n` +
    lines.join("\n") +
    more
  );
}

/** What one tick measured. `unreadable` is NOT zero: see the check below. */
export interface OooCoverageGapResult {
  status: "clear" | "holding" | "unreadable";
  agents: number;
  imminent: number;
  later: number;
}

/**
 * One monitor tick: measure who is holding what inside their own approved absence, page when an
 * imminent gap has persisted, whisper about the further-out ones, and clear when a real read
 * says the imminent gap is closed.
 *
 * The three states are deliberately distinct, and the third is the one this class of defect
 * keeps shipping without:
 *
 *   - an imminent gap: count toward the streak, page once sustained.
 *   - a MEASURED zero imminent: clear the streak and announce recovery. `resolveAlert` is a
 *     no-op unless a page was actually delivered, so a check that never alerted stays silent.
 *     Note this is judged on the IMMINENT count alone: further-out gaps are a different
 *     condition on a different key, and letting them hold the page open would mean the page
 *     could not clear until a worklist emptied (L53).
 *   - a read that FAILED: do neither. An unread worklist comes back empty, and an empty result
 *     here is indistinguishable from "every absence is covered". Announcing recovery off it
 *     would clear a real page, and clearing the streak would reset the count that was about to
 *     fire, both at the moment the system is least able to tell anyone (#1134, #1152).
 *
 * Best-effort by design: monitoring must never take down the lane it watches, so every dispatch
 * is caught and the streak helpers swallow their own errors.
 */
export async function runOooCoverageGapCheck(deps: {
  loadHolders: () => Promise<OooGapHolder[]>;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<OooCoverageGapResult> {
  let holders: OooGapHolder[];
  try {
    holders = await deps.loadHolders();
  } catch (err) {
    // Fail loud in the logs, silent on the alert channels. The lane heartbeat and the
    // migration-drift page cover a database that cannot be read at all; what must not happen is
    // this check turning an unread result into an all-clear.
    log.error("ooo-coverage-gap", { msg: "holder read failed" }, err);
    deps.log?.({ status: "unreadable" });
    return { status: "unreadable", agents: 0, imminent: 0, later: 0 };
  }

  const imminent = holders.reduce((n, h) => n + h.imminent, 0);
  const later = holders.reduce((n, h) => n + h.later, 0);

  // The whisper first and unconditionally, so it is not skipped by the page's early return on a
  // clear tick: "no imminent gap" is exactly when a worklist of further-out ones is most likely
  // to be the only thing anybody could act on.
  if (later > 0) {
    // alert-key: ooo_coverage_gap_later
    await sendThrottledInfo(
      OOO_COVERAGE_GAP_LATER_KEY,
      OOO_GAP_WHISPER_COOLDOWN_MS,
      formatOooCoverageGapWhisper(holders),
    ).catch(() => {});
  }

  if (imminent === 0) {
    await clearFailureStreak(OOO_COVERAGE_GAP_KEY);
    // alert-key: ooo_coverage_gap
    await resolveAlert(OOO_COVERAGE_GAP_KEY, formatOooCoverageGapRecovery()).catch(() => {});
    deps.log?.({ status: "clear", agents: holders.length, imminent: 0, later });
    return { status: "clear", agents: holders.length, imminent: 0, later };
  }

  const sustained = await recordConsecutiveStreak(
    OOO_COVERAGE_GAP_KEY,
    OOO_GAP_WINDOW_SECONDS,
    OOO_GAP_ALERT_AFTER_TICKS,
  );
  if (sustained) {
    // alert-key: ooo_coverage_gap
    await sendThrottledAlert(
      OOO_COVERAGE_GAP_KEY,
      deps.cooldownMs,
      formatOooCoverageGapAlert(holders),
    ).catch(() => {});
  }
  const agents = holders.filter((h) => h.imminent > 0).length;
  deps.log?.({ status: "holding", agents, imminent, later, sustained });
  return { status: "holding", agents, imminent, later };
}
