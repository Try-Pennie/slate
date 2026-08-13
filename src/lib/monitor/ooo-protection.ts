import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { parseStampMs } from "@/lib/date/stamp";
import { formatWhenLine } from "@/lib/ooo/core";
import { log } from "@/lib/log";

/**
 * Is an approved time off still blocking anything? (#1467)
 *
 * Nothing asked. #1464 went from "availability is blocked correctly" to blocking
 * nothing in 31 seconds, and the only reason anyone knows is that a person read
 * three Slack messages side by side and noticed the third contradicted the
 * second. Both messages were true when they were sent, which is exactly why no
 * amount of care at the send sites would have caught it.
 *
 * Slate already probes whether the times it OFFERS are genuinely free
 * (`pnpm verify:availability-truth`, #1315). This is the mirror: every approved
 * request whose window has not passed must have an agent calendar event, or
 * cached busy time covering it. A request with neither is time off that no longer
 * protects the agent, and at cutover that means a lead can be booked into it.
 *
 * It alerts on the SIGNATURE (an approved future request with nothing covering
 * it), never on a count or a rate (L68). The population is tiny while the roster
 * is dark and grows at cutover, so any threshold calibrated today would be
 * calibrated on nothing.
 */

/** alert_state row key for the throttle. */
export const OOO_PROTECTION_KEY = "ooo_protection_lost";

/**
 * The key the ORCHESTRATION uses when an approval falls back to a Slate written
 * busy block because the agent's calendar event could not be created (#1470).
 *
 * Sent there, at the moment it happens; cleared here, because only a measurement
 * can say it has stopped being true. It was classified as an incident, so it
 * could never retract itself, and its text ("Availability is blocked correctly")
 * was true for 31 seconds and false forever after in #1464. It is a condition:
 * it ends when nothing is relying on that block any more, either because the
 * calendar event was created or because the window has passed.
 */
export const OOO_FALLBACK_KEY = "ooo_busy_block_fallback";

/**
 * Consecutive ticks before this pages. The monitor lane runs every 5 minutes.
 *
 * Two, not one, for a specific legitimate transient: approval flips the request
 * to `approved` and only THEN creates the calendar event and writes the busy
 * block, and a Google create can take seconds. A tick landing inside that window
 * sees an approved request with no protection yet, which is not damage. Nothing
 * else produces this state briefly, so two ticks (about 10 minutes) is enough to
 * exclude it while still catching a lost cover long before the day arrives.
 */
export const OOO_PROTECTION_ALERT_AFTER_TICKS = 2;

/** Streak window. Comfortably longer than 2 ticks * 5 min, with slack for a
 *  delayed tick, so genuinely consecutive ticks land in the same window. */
export const OOO_PROTECTION_WINDOW_SECONDS = 30 * 60;

/** One approved time off, as the monitor reads it. */
export interface ApprovedTimeOff {
  id: string;
  userId: string;
  agentName: string | null;
  agentEmail: string | null;
  startsAt: string;
  endsAt: string;
  displayTzId: string;
  displayTzLabel: string | null;
  /** The event on the AGENT's own calendar, which blocks the window at Google. */
  agentEventId: string | null;
  /** `side_effects.busy_block` as stored, so the alert can name the shape where
   *  the record disagrees with reality: a stored "ok" over a cover that is gone. */
  busyBlockEffect: string | null;
  /** `side_effects.agent_event` as stored. Read only to answer "did Slate ever
   *  act on this request", below. */
  agentEventEffect: string | null;
}

/** One cached busy period, as the monitor reads it. */
export interface CachedBusyWindow {
  userId: string;
  startsAt: string;
  endsAt: string;
}

/** An approved time off with nothing left blocking (part of) its window. */
export interface UnprotectedTimeOff {
  requestId: string;
  userId: string;
  agentName: string | null;
  agentEmail: string | null;
  startsAt: string;
  endsAt: string;
  displayTzId: string;
  displayTzLabel: string | null;
  /**
   * The request still records the busy block as "ok" while nothing is covering the
   * window (#1464). Worth naming because the record itself is misleading: anyone
   * reading that row, or any future guard that decides from the marker rather than
   * the artifact, would be told this one is fine.
   */
  claimedOk: boolean;
}

/** Merge overlapping or abutting intervals into ascending, disjoint ones. */
function merge(intervals: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/**
 * Which approved windows are no longer covered.
 *
 * Pure, so the rule that decides "still protected" is pinned by tests rather
 * than living inside a query nothing can assert against.
 *
 * Three deliberate choices:
 *
 *  - An `agent_event_id` is protection on its own. The event is on the agent's
 *    own calendar, so Google's own answer blocks the window whether or not our
 *    cache currently mirrors it, and verify-on-book reads Google at confirm time.
 *  - Only the part of the window that is still in the FUTURE is judged. A time
 *    off already under way cannot be booked into for the hours that have passed,
 *    and reporting those would page about something nobody can act on.
 *  - A row whose bounds cannot be READ is not coverage. `parseStampMs` returns
 *    null rather than NaN precisely so an unreadable value cannot land on the
 *    permissive side of a comparison (L50), and the permissive side here is
 *    "this window is fine".
 */
type Protection =
  | "protected"
  | "fallback-only"
  | "unprotected"
  | "past"
  | "not-handled";

/**
 * Did Slate ever act on this request? (#1485)
 *
 * Selection is on a RECORDED OUTCOME, never on the bare approved status. Ten of
 * the 35 approved future periods on production the hour this check shipped were
 * imported from the old Apps Script tool: approved, and carrying no side effects
 * at all, because Slate never ran a single step for them. They match every part
 * of the unprotected signature while being nothing to do with the defect this
 * page exists to catch (a cover Slate WROTE and then lost), so the first tick
 * paged ten times over.
 *
 * The same rule the cal.com override sweep arrived at (#1253): keyed on the flag
 * it matched 634 rows, 631 of them predating the feature; keyed on a recorded
 * failure it matched 2.
 *
 * The cost of the exclusion, named rather than hidden: an imported record that is
 * genuinely unprotected does not page here. That backlog is #1486, and the
 * excluded rows are counted on every tick so the exclusion cannot go quiet.
 */
function slateActedOn(r: ApprovedTimeOff): boolean {
  return r.busyBlockEffect !== null || r.agentEventEffect !== null || r.agentEventId !== null;
}

/**
 * One pass over the requests, classifying each. Both exported views read this,
 * so "covered" can never mean two different things on two surfaces.
 */
function classify(
  requests: ApprovedTimeOff[],
  blocks: CachedBusyWindow[],
  nowMs: number,
): { request: ApprovedTimeOff; state: Protection }[] {
  const byUser = new Map<string, { start: number; end: number }[]>();
  for (const b of blocks) {
    const start = parseStampMs(b.startsAt);
    const end = parseStampMs(b.endsAt);
    if (start === null || end === null || end <= start) continue;
    const list = byUser.get(b.userId) ?? [];
    list.push({ start, end });
    byUser.set(b.userId, list);
  }

  return requests.map((r) => {
    if (!slateActedOn(r)) return { request: r, state: "not-handled" as const };
    const start = parseStampMs(r.startsAt);
    const end = parseStampMs(r.endsAt);
    // An unreadable window is reported rather than waved through: the stored
    // columns are NOT NULL timestamptz, so this cannot happen without something
    // else being wrong, and a detector that silently passes what it cannot read
    // is the failure this whole feature exists to notice.
    if (start === null || end === null) return { request: r, state: "unprotected" as const };
    if (end <= nowMs) return { request: r, state: "past" as const };
    if (r.agentEventId) return { request: r, state: "protected" as const };
    const from = Math.max(start, nowMs);
    const covered = merge(byUser.get(r.userId) ?? []).some(
      (iv) => iv.start <= from && iv.end >= end,
    );
    // Covered, but by cached busy time alone with no event on the agent's own
    // calendar: working, and relying on the one row this system keeps losing.
    return { request: r, state: covered ? ("fallback-only" as const) : ("unprotected" as const) };
  });
}

function found(r: ApprovedTimeOff): UnprotectedTimeOff {
  return {
    requestId: r.id,
    userId: r.userId,
    agentName: r.agentName,
    agentEmail: r.agentEmail,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    displayTzId: r.displayTzId,
    displayTzLabel: r.displayTzLabel,
    claimedOk: (r.busyBlockEffect ?? "").startsWith("ok"),
  };
}

/** Approved windows with nothing blocking them at all: a lead can be booked in. */
export function unprotectedTimeOff(
  requests: ApprovedTimeOff[],
  blocks: CachedBusyWindow[],
  nowMs: number,
): UnprotectedTimeOff[] {
  return classify(requests, blocks, nowMs)
    .filter((c) => c.state === "unprotected")
    .map((c) => found(c.request));
}

/**
 * Approved windows blocked ONLY by cached busy time, with no event on the
 * agent's own calendar (#1470).
 *
 * Degraded but working, which is why it is not the same finding as an
 * unprotected window and must not share its status (L53): one is a lead being
 * bookable into time off, the other is protection resting on a single cached row.
 */
export function fallbackOnlyTimeOff(
  requests: ApprovedTimeOff[],
  blocks: CachedBusyWindow[],
  nowMs: number,
): UnprotectedTimeOff[] {
  return classify(requests, blocks, nowMs)
    .filter((c) => c.state === "fallback-only")
    .map((c) => found(c.request));
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post rather than a wall of names.
const NAME_CAP = 8;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function whoLine(f: UnprotectedTimeOff, appBaseUrl: string): string {
  const who = f.agentName?.trim() || f.agentEmail || f.userId;
  const when = formatWhenLine(
    f.startsAt,
    f.endsAt,
    f.displayTzId,
    f.displayTzLabel ?? undefined,
  );
  // What `claimedOk` is worth to the reader: the request's own record disagrees
  // with reality, so nothing else in Slate will report this one. It is not a
  // statement about repairability, because nothing repairs any of these on its
  // own: the calendar work only re-runs when a person opens the request.
  const claim = f.claimedOk
    ? " The request itself still records the block as written, so nothing else will report this one."
    : "";
  return `${who}, ${when}. ${appBaseUrl}/admin/ooo?request=${f.requestId}${claim}`;
}

/**
 * The page. States the customer-facing consequence first (that is what decides
 * whether someone acts at 7am), then names who and when, then links the request
 * that fixes it.
 */
export function formatOooProtectionAlert(
  found: UnprotectedTimeOff[],
  appBaseUrl: string,
): string {
  const one = found.length === 1;
  const lines = found.slice(0, NAME_CAP).map((f) => whoLine(f, appBaseUrl));
  const more = found.length > NAME_CAP ? `\n(and ${found.length - NAME_CAP} more)` : "";
  return (
    `${plural(found.length, "approved time off request", "approved time off requests")} ` +
    `${one ? "is" : "are"} no longer blocking anything: there is no calendar event and no ` +
    `cached busy time covering ${one ? "it" : "them"}, so a lead can be booked into ` +
    `${one ? "that window" : "those windows"}. Nothing repairs this on its own. Open ` +
    `${one ? "the request" : "each request"} and retry the calendar updates.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all-clear. Says the protection is back and deliberately does not repeat the
 * page's remediation: the reader is being told to stand down.
 */
export function formatOooProtectionRecovery(): string {
  return (
    `Every approved time off still ahead of us is blocking its window again, either ` +
    `with a calendar event or with cached busy time, so no lead can be booked into one. ` +
    `No action is needed.`
  );
}

/**
 * The all-clear for the fallback notice (#1470).
 *
 * It says only what was measured: nothing is relying on that block now. It does
 * NOT claim the calendar event was created, because the condition also ends when
 * the window simply passes, and a recovery notice that names a repair nobody
 * performed sends the reader looking for work that was never done.
 */
export function formatFallbackClearedRecovery(): string {
  return (
    `No approved time off is relying on a Slate written busy block any more: every ` +
    `approved window still ahead of us has an event on the agent's own calendar, or ` +
    `has passed. No action is needed.`
  );
}

/** What one tick measured. `unreadable` is NOT zero: see the check below. */
export interface OooProtectionResult {
  status: "clear" | "unprotected" | "unreadable";
  /** Approved, not yet finished requests examined. */
  scanned: number;
  unprotected: number;
  /** Of `scanned`, the imported records Slate never acted on (#1485). */
  notHandled: number;
  /**
   * The read succeeded, so this tick answered the question. Drives the
   * `verdict:` stamp (#1394): a detector that only ever fails to read must not
   * look like one that keeps finding nothing wrong.
   */
  reachedVerdict: boolean;
}

/**
 * One monitor tick.
 *
 * Three states, and the third is the one this class of defect keeps shipping
 * without:
 *
 *   - unprotected windows found: count toward the streak, page once sustained.
 *   - a MEASURED zero: clear the streak and announce recovery. `resolveAlert` is
 *     a no-op unless a page was really delivered, so a check that never alerted
 *     stays silent.
 *   - a read that FAILED: do neither, and stamp no verdict. An unread worklist
 *     comes back empty, and an empty result here is indistinguishable from "every
 *     time off is protected" (#1134, #1152).
 *
 * A scan that finds no approved future time off IS a measured verdict: the read
 * worked and the question is answered, because nothing approved can be
 * unprotected. `scanned` is reported so a read that is permanently returning
 * nothing (a wrong filter, a renamed status) is visible in the log rather than
 * reading as sustained health (L98).
 *
 * Best-effort by design: monitoring must never take down the lane it watches, so
 * both dispatches are caught and the streak helpers swallow their own errors.
 */
export async function runOooProtectionCheck(deps: {
  load: () => Promise<{ requests: ApprovedTimeOff[]; blocks: CachedBusyWindow[] }>;
  nowMs: number;
  appBaseUrl: string;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<OooProtectionResult> {
  let requests: ApprovedTimeOff[];
  let blocks: CachedBusyWindow[];
  try {
    ({ requests, blocks } = await deps.load());
  } catch (err) {
    log.error("ooo-protection", { msg: "approved time off read failed" }, err);
    deps.log?.({ status: "unreadable" });
    return {
      status: "unreadable",
      scanned: 0,
      unprotected: 0,
      notHandled: 0,
      reachedVerdict: false,
    };
  }

  const found = unprotectedTimeOff(requests, blocks, deps.nowMs);
  const notHandled = requests.filter((r) => !slateActedOn(r)).length;

  // #1470, judged independently of the page above (L53: two checks must never
  // share one status). A window blocking nothing at all is a different condition
  // with a different remedy, and is no reason to keep saying something is relying
  // on the fallback. Reached only on a MEASURED read, never on a failed one.
  if (fallbackOnlyTimeOff(requests, blocks, deps.nowMs).length === 0) {
    // alert-key: ooo_busy_block_fallback
    await resolveAlert(OOO_FALLBACK_KEY, formatFallbackClearedRecovery()).catch(() => {});
  }

  if (found.length === 0) {
    await clearFailureStreak(OOO_PROTECTION_KEY);
    // alert-key: ooo_protection_lost
    await resolveAlert(OOO_PROTECTION_KEY, formatOooProtectionRecovery()).catch(() => {});
    deps.log?.({
      status: "clear",
      scanned: requests.length,
      unprotected: 0,
      not_handled: notHandled,
    });
    return {
      status: "clear",
      scanned: requests.length,
      unprotected: 0,
      notHandled,
      reachedVerdict: true,
    };
  }

  const sustained = await recordConsecutiveStreak(
    OOO_PROTECTION_KEY,
    OOO_PROTECTION_WINDOW_SECONDS,
    OOO_PROTECTION_ALERT_AFTER_TICKS,
  );
  if (sustained) {
    // alert-key: ooo_protection_lost
    await sendThrottledAlert(
      OOO_PROTECTION_KEY,
      deps.cooldownMs,
      formatOooProtectionAlert(found, deps.appBaseUrl),
    ).catch(() => {});
  }
  deps.log?.({
    status: "unprotected",
    scanned: requests.length,
    unprotected: found.length,
    not_handled: notHandled,
    sustained,
    request_ids: found.slice(0, NAME_CAP).map((f) => f.requestId),
  });
  return {
    status: "unprotected",
    scanned: requests.length,
    unprotected: found.length,
    notHandled,
    reachedVerdict: true,
  };
}
