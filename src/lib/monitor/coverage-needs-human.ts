import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";
import { formatWhenLine } from "@/lib/ooo/core";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { parseStampMs } from "@/lib/date/stamp";
import type { BulkReassignJobStatus } from "@/lib/db/types";
import { log } from "@/lib/log";

/**
 * Why the agent will not be there (#3485). The sweep that stranded a call records
 * its origin on the job in mutually exclusive columns (the time-off request,
 * offboarding, a Twilio pool exit or tier demotion, or an admin), and this is that
 * origin decoded, so the alert can say the reason rather than only "an agent who
 * will not be there". For approved time off the window travels too, in the request's
 * OWN display zone, so the page names it WITHOUT the agent's free-text reason, which
 * is often personal and does not belong in a shared channel (Dan, 2026-10-11).
 */
export type SweepCause =
  | {
      kind: "time-off";
      timeOff: { startsAt: string; endsAt: string; tzId: string | null; tzLabel: string | null };
    }
  | { kind: "offboarded" }
  | { kind: "redistribute" }
  | { kind: "demotion" }
  | { kind: "admin" }
  | { kind: "unknown" };

/** The window of an approved time off, in its own display zone, for a `time-off` cause. */
export interface TimeOffWindow {
  startsAt: string;
  endsAt: string;
  tzId: string | null;
  tzLabel: string | null;
}

/**
 * Best-effort time-off windows for the stranded page's reason clause (#3485). This read
 * ONLY enriches the page with "on time off <when>", so a failure must degrade
 * to no window and NEVER propagate: were it to throw out of the loader, the whole
 * stranded check would report `unreadable` and a real page would be suppressed for the
 * sake of a cosmetic clause (review finding, 2026-10-11). On failure it reports through
 * `onError` and returns an empty map, and the ooo causes then render without their
 * window. No ids means no fetch.
 */
export async function loadTimeOffWindows(
  oooIds: string[],
  fetchWindows: (ids: string[]) => Promise<Array<{ id: string } & TimeOffWindow>>,
  onError?: (err: unknown) => void,
): Promise<Map<string, TimeOffWindow>> {
  if (oooIds.length === 0) return new Map();
  try {
    const rows = await fetchWindows(oooIds);
    return new Map(
      rows.map((r) => [r.id, { startsAt: r.startsAt, endsAt: r.endsAt, tzId: r.tzId, tzLabel: r.tzLabel }]),
    );
  } catch (err) {
    onError?.(err);
    return new Map();
  }
}

/**
 * Decode why a sweep's out agent will not be there (#3485) from the job's mutually
 * exclusive origin columns. An approved-time-off sweep carries `created_by` (the
 * approver) AND `ooo_request_id`, so the request is checked FIRST: the reader needs
 * the absence, not who signed it off. A time-off sweep whose window could not be read
 * is `unknown`, never a half-stated "on time off" with no when (L11): a reason the
 * reader cannot act on is worse than none. The order matches `coverageSweepActor`'s
 * accountability decode, which is the same columns asked a different question.
 */
export function decodeSweepCause(
  job: {
    ooo_request_id?: string | null;
    offboarding_deactivated_at?: string | null;
    redistribute_marked_at?: string | null;
    demotion_marked_at?: string | null;
    created_by?: string | null;
  },
  timeOff?: TimeOffWindow | null,
): SweepCause {
  if (job.ooo_request_id) return timeOff ? { kind: "time-off", timeOff } : { kind: "unknown" };
  if (job.offboarding_deactivated_at) return { kind: "offboarded" };
  if (job.redistribute_marked_at) return { kind: "redistribute" };
  if (job.demotion_marked_at) return { kind: "demotion" };
  if (job.created_by) return { kind: "admin" };
  return { kind: "unknown" };
}

/**
 * Whether two causes are the same reason (#3485). Same kind, and for time off the same
 * window: two approved time offs of different windows are NOT the same reason, so a
 * holder stranded by both must not be told one of the two windows for all its calls.
 */
function sameCause(a: SweepCause, b: SweepCause): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "time-off" && b.kind === "time-off") {
    return (
      a.timeOff.startsAt === b.timeOff.startsAt &&
      a.timeOff.endsAt === b.timeOff.endsAt &&
      a.timeOff.tzId === b.timeOff.tzId &&
      a.timeOff.tzLabel === b.timeOff.tzLabel
    );
  }
  return true;
}

/**
 * Appointments a coverage sweep gave up on (#1242).
 *
 * When the bulk sweep cannot place one, it settles the item as `unplaceable`
 * (no other advisor was available at that time) or, after exhausting
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

/**
 * What the stranded page names, for the repeat rule (#3801): one subject per agent
 * still holding a call nobody could move. An agent the last page did not name is a
 * change and posts at once; the same agents are said again once a day.
 */
export function coverageNeedsHumanSubjects(holders: readonly { userId: string }[]): string[] {
  return holders.map((h) => `agent:${h.userId}`);
}

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
  /** Why the out agent will not be there (#3485), from the sweep that stranded it. */
  cause?: SweepCause;
  /** The call's start (#3485), so the page can say how soon the first one is. */
  startsAt?: string;
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
    /**
     * Whether this sweep was triggered by a Redistribute tag (#3597). Only then does the
     * agent being back in the pool mean the call is covered. A sweep from APPROVED TIME
     * OFF moves calls out of an agent who stays in the pool but is genuinely away during
     * the window, so an in-pool holder there is still stranded and must keep paging.
     */
    fromRedistribute: boolean;
    /** Why this sweep's out agent will not be there (#3485), decoded from the job. */
    cause?: SweepCause;
  };
  /**
   * The booking's start (#3485 part C), so the page can hold until the call is within the
   * lead window. Optional: absent means no lead gate (the call is paged whenever it is
   * otherwise countable), the safe direction when the time is unknown.
   */
  startsAt?: string;
  /** Who holds the booking now, or null when it is no longer active and upcoming. */
  assignedUserId: string | null;
  /**
   * Whether the agent holding it is back IN THE POOL (#3597): judged by `hasLeftPool`,
   * so it is true only when the agent is genuinely available again (bookable, not
   * deactivated, not awaiting activation), not merely carrying a stale `bookable` flag.
   * A coverage sweep fires on a Redistribute tag, but the tag can clear minutes later (a
   * transient flap), and the agent is then back and will take the call: it is no longer
   * stranded. The `unplaceable`/`failed` item is a frozen record of a past moment, so
   * without this the monitor pages for ever about a call that is already covered. A
   * DEPARTED agent (deactivated) is NOT in the pool, so their stranded calls still page.
   */
  assignedAgentInPool: boolean;
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

/**
 * How long before a stranded call's start the page is allowed to fire (#3485 part C).
 * Dan, 2026-10-11: retry hourly, page one hour before. Until the call is within this
 * window of its start it is held (counts as `waiting`, never a false all-clear) while
 * the hourly retry works it; inside the window it pages. A call whose start is unknown
 * is never held, the safe direction.
 */
export const COVERAGE_PAGE_LEAD_MS = 60 * 60_000;

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
 *
 * `leadMs` is the paging lead window (#3485 part C): a give up is NOT pageable until the
 * call is within `leadMs` of its start, so a call stranded days out is held (it reads as
 * `waiting`, never a false all-clear) while the hourly retry works it. When it enters the
 * window, that moment (start minus lead) is when it became pageable, which is the news
 * moment the cooldown fires on, not the old give-up. `Infinity` (the default) disables the
 * gate, and an absent or unreadable start is never held, the safe direction.
 */
function countableAt(it: StrandedItemRead, asOfMs: number, leadMs: number): number | null | false {
  const settledMs = parseStampMs(it.settledAt);
  const boundMs = settledMs === null ? null : settledMs + SWEEP_FINISH_WAIT_MS;
  const base: number | null | false = (() => {
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
  })();
  if (base === false) return false;
  // No lead gate (the default): keep the #3303 give-up moment unchanged.
  if (!Number.isFinite(leadMs)) return base;
  // An absent or unreadable start is never held (page it): the safe side.
  const startMs = it.startsAt ? parseStampMs(it.startsAt) : null;
  if (startMs === null) return base;
  const leadBound = startMs - leadMs;
  if (leadBound > asOfMs) return false; // not within the lead window yet: held as waiting
  // Pageable at the LATER of the give-up moment and when it entered the window: a call
  // stranded well before the window becomes news as it enters (leadBound), while one
  // stranded inside the window becomes news when it was given up (base), never dated before
  // it existed. This is stable across the hourly retry because the retry leaves the sweep
  // `done` (it does not reactivate it), so the finish time `base` reads does not churn. A
  // base of null (unreadable give-up stamp) still cannot be news, so it stays null.
  return base === null ? null : Math.max(base, leadBound);
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
 *
 * `leadMs` is the paging lead window (#3485 part C): a give up whose call is more than
 * `leadMs` from its start is held as `waiting` rather than counted, so a call stranded
 * days out does not page until it is imminent. The default is `Infinity` (no gate), so
 * existing callers are unchanged.
 */
export function countStranded(
  items: StrandedItemRead[],
  asOfMs: number,
  leadMs: number = Infinity,
): CountedStranded {
  const counted = new Map<string, { appt: StrandedAppointment; atMs: number | null; settledMs: number }>();
  const held = new Set<string>();
  for (const it of items) {
    if (it.assignedUserId === null || it.assignedUserId !== it.sweep.outUserId) continue;
    // #3597: a Redistribute flap cleared, so the agent is back in the pool and will take
    // the call: it is covered and no longer stranded. Not `held`, because there is nothing
    // to wait for: it is resolved, and a later tick must not resurrect it. Scoped to
    // Redistribute sweeps ONLY: an approved-time-off sweep moves calls out of an agent who
    // STAYS in the pool but is away during the window, so an in-pool holder there is still
    // stranded. A departed agent is not in the pool, so their stranded calls still count.
    if (it.assignedAgentInPool && it.sweep.fromRedistribute) continue;
    const at = countableAt(it, asOfMs, leadMs);
    if (at === false) {
      held.add(it.bookingId);
      continue;
    }
    const settledMs = parseStampMs(it.settledAt) ?? Number.NEGATIVE_INFINITY;
    const appt: StrandedAppointment = {
      bookingId: it.bookingId,
      outUserId: it.sweep.outUserId,
      status: it.status,
      // #3485: the cause travels with the appointment so the holder, and then the
      // alert, can say why. The dedupe below keeps the latest attempt's appt, so the
      // cause follows the most recent sweep that gave up on this call.
      cause: it.sweep.cause,
      ...(it.startsAt ? { startsAt: it.startsAt } : {}),
    };
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
  /** No other advisor was available at the original time. */
  unplaceable: number;
  /** The move itself kept erroring until it ran out of attempts. */
  failed: number;
  /**
   * Why this agent will not be there (#3485), so the alert says the reason rather than
   * only "an agent who will not be there". Undefined when the loader did not resolve it;
   * `unknown` when a holder's stranded calls came from sweeps that disagree on why, so
   * no one reason is true of them all. Rendered as a clause, never the agent's own
   * free-text reason.
   */
  cause?: SweepCause;
  /** The earliest readable start among this agent's stranded calls (#3485); absent when none is known. */
  firstStartsAt?: string;
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
    // A holder's cause is the ONE reason true of ALL its stranded calls, else unknown
    // (#3485). A call with no resolved cause is itself a disagreement: a later call's
    // reason must not be claimed for it, so an unresolved cause is normalised to unknown
    // and compared like any other (review finding, 2026-10-11). "Disagree" also covers
    // two approved time offs with DIFFERENT windows, same kind but not the same when.
    const cause: SweepCause = it.cause ?? { kind: "unknown" };
    let h = holders.get(it.outUserId);
    if (!h) {
      const agent = byId.get(it.outUserId);
      h = {
        userId: it.outUserId,
        name: agent?.name ?? null,
        email: agent?.email ?? null,
        unplaceable: 0,
        failed: 0,
        cause,
      };
      holders.set(it.outUserId, h);
    } else if (!sameCause(h.cause ?? { kind: "unknown" }, cause)) {
      h.cause = { kind: "unknown" };
    }
    if (it.status === "failed") h.failed++;
    else h.unplaceable++;
    const first = earlierStart(h.firstStartsAt, it.startsAt);
    if (first) h.firstStartsAt = first;
  }
  const total = (h: StrandedHolder) => h.unplaceable + h.failed;
  return [...holders.values()].sort(
    (x, y) => total(y) - total(x) || x.userId.localeCompare(y.userId),
  );
}

/** The earlier of two starts that parse; an unreadable one never wins (#3485). */
function earlierStart(a: string | undefined, b: string | undefined): string | undefined {
  const aMs = a ? parseStampMs(a) : null;
  const bMs = b ? parseStampMs(b) : null;
  if (aMs === null) return bMs === null ? undefined : b;
  if (bMs === null) return a;
  return bMs < aMs ? b : a;
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post rather than a wall of names.
const NAME_CAP = 8;

/** The page's times are Eastern, as every other monitor notice's are. */
const ALERT_ZONE = "America/New_York";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Who the agent is, preferring a name and never rendering a placeholder. */
const whoIs = (h: StrandedHolder): string => {
  const who = h.name?.trim() || h.email || h.userId;
  return h.email && h.email !== who ? `${who} (${h.email})` : who;
};

/**
 * Escape a Slack link LABEL (#3485). An agent name is DB text, so a stray `<`, `>`,
 * `&` or `|` would break the `<url|label>` link or the message around it: `>` ends the
 * link, `|` is the url/label separator. Slack escapes the first three as entities; `|`
 * has no entity, so it becomes a slash.
 */
const slackLabel = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "/");

/**
 * The holder, linked to their page in Admin when a base url is known (#3485), which
 * is where the Move-bookings panel that fixes this lives, so the reader acts in one
 * tap. A bare holder (no base url) renders as before.
 */
const whoLink = (h: StrandedHolder, appBaseUrl?: string): string =>
  appBaseUrl ? `<${appBaseUrl}/admin/agents/${h.userId}|${slackLabel(whoIs(h))}>` : whoIs(h);

/**
 * Why the agent will not be there, as a short NOUN phrase for the holder line (#3485), or
 * null when there is nothing specific to say. Reads as "<name>, <phrase>: N appointments".
 * Never the agent's own free-text reason: the kind, and for time off the window in the
 * request's display zone (Dan, 2026-10-11).
 */
function causePhrase(cause: SweepCause | undefined): string | null {
  if (!cause) return null;
  switch (cause.kind) {
    case "time-off": {
      const { startsAt, endsAt, tzId, tzLabel } = cause.timeOff;
      return `on time off ${formatWhenLine(startsAt, endsAt, tzId ?? "Etc/UTC", tzLabel ?? undefined)}`;
    }
    case "offboarded":
      return "left the pool";
    case "redistribute":
      return "taken out of the routing pool";
    case "demotion":
      return "changed routing tier";
    case "admin":
      return "taken out of this pool by an admin";
    case "unknown":
      return null;
  }
}

/**
 * One holder line (#3485, redesigned for readability 2026-10-11): the advisor, linked to
 * their Move-bookings page, their absence reason, and how many calls. NO booking ids: Dan,
 * 2026-10-11, chose the clean advisor-link form over the per-booking uuid list (#3594),
 * which rendered as a wall of ids on a phone; the specific calls are on the advisor's page
 * the name links to. The two outcomes stay distinct only when a move actually kept failing,
 * since that needs different handling (L11); otherwise the count is just the appointments.
 */
function holderLine(h: StrandedHolder, appBaseUrl?: string): string {
  const total = h.unplaceable + h.failed;
  // The failed count is a SUBSET of the total, so render it as "N appointments, M where the
  // move kept failing" (not "4, 2" which reads as 4 plus 2 = 6 or as 4 of which 2). The two
  // outcomes need different handling (L11), so a move that kept erroring is still called out.
  let count: string;
  if (h.unplaceable > 0 && h.failed > 0) {
    count = `${plural(total, "appointment", "appointments")}, ${h.failed} where the move kept failing`;
  } else if (h.failed > 0) {
    count = `${plural(h.failed, "appointment", "appointments")} where the move kept failing`;
  } else {
    count = plural(h.unplaceable, "appointment", "appointments");
  }
  const who = whoLink(h, appBaseUrl);
  const phrase = causePhrase(h.cause);
  return phrase ? `${who}, ${phrase}: ${count}` : `${who}: ${count}`;
}

/**
 * The page. States the customer-facing consequence and the reason first (could not be
 * moved, because no one else was free), then each advisor: their name linked to the
 * Move-bookings page that fixes it, WHY they will not be there (#3485: the sweep's cause,
 * and for time off the absence window), and how many calls. Redesigned for readability on
 * 2026-10-11 (Dan): the per-booking uuid links (#3594) rendered as a wall on a phone, so
 * the specific calls now live on the advisor's page the name links to, and the alert
 * carries no booking ids. The bookings' OWN times are left out for the same reason.
 *
 * Verbs agree with the subject in both directions. Counting the nouns is not
 * enough, which is only visible rendered (`pnpm preview:alerts`).
 */
export function formatCoverageNeedsHumanAlert(holders: StrandedHolder[], appBaseUrl?: string): string {
  const total = holders.reduce((n, h) => n + h.unplaceable + h.failed, 0);
  const one = total === 1;
  const oneAgent = holders.length === 1;
  const lines = holders.slice(0, NAME_CAP).map((h) => holderLine(h, appBaseUrl));
  const more = holders.length > NAME_CAP ? `\n(and ${holders.length - NAME_CAP} more)` : "";
  // Why it could not be moved is stated once, up front, because that is the question a
  // reader asks (Dan, 2026-10-11), and it may claim only what is true (L11). There are only
  // two outcomes: no one else was free, or the move kept erroring. When every call is one
  // outcome the headline gives that reason; when a page mixes them it splits the count by
  // reason, so "no one was free" is never claimed for a failed move. The specific calls live
  // on the advisor's page the name links to, so the alert carries no booking ids.
  const totalUnplaceable = holders.reduce((n, h) => n + h.unplaceable, 0);
  const totalFailed = holders.reduce((n, h) => n + h.failed, 0);
  const headline =
    totalFailed === 0
      ? `${plural(total, "appointment", "appointments")} could not be moved to another advisor, because no one else was free at ${one ? "that time" : "those times"}.`
      : totalUnplaceable === 0
        ? `${plural(total, "appointment", "appointments")} could not be moved to another advisor, because the move kept failing.`
        : `${plural(total, "appointment", "appointments")} could not be moved to another advisor: ${totalUnplaceable} because no one else was free, and ${totalFailed} because the move kept failing.`;
  // How soon (#3485 Part 2): the earliest call's start, since that is what decides how fast
  // somebody has to act. One time, never a list, so the page stays readable on a phone.
  const first = holders.reduce<string | undefined>((at, h) => earlierStart(at, h.firstStartsAt), undefined);
  const when = first
    ? ` ${one ? "It starts" : "The first starts"} ${formatSlotDay(first, ALERT_ZONE)} at ${formatSlotTime(first, ALERT_ZONE)} ET.`
    : "";
  // What happens next: the hourly retry re-arms only the calls no one was free for
  // (`coverage-retry.ts`), never a move that kept failing, so only those are promised it.
  const oneRetried = totalUnplaceable === 1;
  const retried =
    totalUnplaceable === 0
      ? ""
      : totalFailed === 0
        ? ` Slate keeps trying to move ${one ? "it" : "them"} about once an hour until ${one ? "it starts" : "they start"}.`
        : ` Slate keeps trying to move the ${totalUnplaceable} no one was free for about once an hour until ${oneRetried ? "it starts" : "they start"}.`;
  // The fix is each call's own Place by hand, listed in the panel. The panel's own button
  // starts the automatic move that just failed (#3485 comment, 2026-10-12).
  return (
    `${headline} ` +
    `${one ? "It is" : "They are"} still with ` +
    `${oneAgent ? "an advisor who will not be there" : "advisors who will not be there"}.` +
    when +
    retried +
    `\nTo place ${one ? "it" : "them"} now, open the advisor's page in Admin and use Place by hand on ` +
    `${one ? "the call" : "each call"} under ${COVERAGE_PANEL_NAME}:\n` +
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
    `No customer is left holding an appointment with an advisor who will not be there, so no ` +
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
  /**
   * The deployment's base url (#3485), so the page can link each advisor to their page.
   * Optional: omitted, the page renders each advisor's plain name instead of a link.
   */
  appBaseUrl?: string;
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
    formatCoverageNeedsHumanAlert(holders, read.appBaseUrl),
    {
      // #3801: the agents the page names are its subjects, so a new one posts at once
      // and the same ones are said again once a day. A new APPOINTMENT for an agent
      // already named posts at once too, through the page news below (#3303).
      subjects: coverageNeedsHumanSubjects(holders),
      news: { newestMs: read.newestCountableMs, asOfMs: read.asOfMs },
    },
  ).catch(logAlertSendFailure(COVERAGE_NEEDS_HUMAN_KEY));
  deps.log?.({ status: "stranded", agents: holders.length, appointments, waiting });
  return { status: "stranded", agents: holders.length, appointments, waiting };
}
