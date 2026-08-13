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
export function unprotectedTimeOff(
  requests: ApprovedTimeOff[],
  blocks: CachedBusyWindow[],
  nowMs: number,
): UnprotectedTimeOff[] {
  const byUser = new Map<string, { start: number; end: number }[]>();
  for (const b of blocks) {
    const start = parseStampMs(b.startsAt);
    const end = parseStampMs(b.endsAt);
    if (start === null || end === null || end <= start) continue;
    const list = byUser.get(b.userId) ?? [];
    list.push({ start, end });
    byUser.set(b.userId, list);
  }

  const found: UnprotectedTimeOff[] = [];
  for (const r of requests) {
    if (r.agentEventId) continue;
    const start = parseStampMs(r.startsAt);
    const end = parseStampMs(r.endsAt);
    // An unreadable window is reported rather than waved through: the stored
    // columns are NOT NULL timestamptz, so this cannot happen without something
    // else being wrong, and a detector that silently passes what it cannot read
    // is the failure this whole feature exists to notice.
    const from = start === null ? null : Math.max(start, nowMs);
    if (start !== null && end !== null) {
      if (end <= nowMs) continue; // wholly in the past: nothing can be booked into it
      const covered = merge(byUser.get(r.userId) ?? []).some(
        (iv) => iv.start <= (from as number) && iv.end >= end,
      );
      if (covered) continue;
    }
    found.push({
      requestId: r.id,
      userId: r.userId,
      agentName: r.agentName,
      agentEmail: r.agentEmail,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      displayTzId: r.displayTzId,
      displayTzLabel: r.displayTzLabel,
      claimedOk: (r.busyBlockEffect ?? "").startsWith("ok"),
    });
  }
  return found;
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

/** What one tick measured. `unreadable` is NOT zero: see the check below. */
export interface OooProtectionResult {
  status: "clear" | "unprotected" | "unreadable";
  /** Approved, not yet finished requests examined. */
  scanned: number;
  unprotected: number;
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
    return { status: "unreadable", scanned: 0, unprotected: 0, reachedVerdict: false };
  }

  const found = unprotectedTimeOff(requests, blocks, deps.nowMs);

  if (found.length === 0) {
    await clearFailureStreak(OOO_PROTECTION_KEY);
    // alert-key: ooo_protection_lost
    await resolveAlert(OOO_PROTECTION_KEY, formatOooProtectionRecovery()).catch(() => {});
    deps.log?.({ status: "clear", scanned: requests.length, unprotected: 0 });
    return {
      status: "clear",
      scanned: requests.length,
      unprotected: 0,
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
    sustained,
    request_ids: found.slice(0, NAME_CAP).map((f) => f.requestId),
  });
  return {
    status: "unprotected",
    scanned: requests.length,
    unprotected: found.length,
    reachedVerdict: true,
  };
}
