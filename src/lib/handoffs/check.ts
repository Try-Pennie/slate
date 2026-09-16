import { parseStampMs } from "@/lib/date/stamp";
import { shortFailureReason } from "@/lib/notify/error-text";
import { readOwnerDetail, type HandoffKind } from "@/lib/handoffs/kinds";
import {
  formatHandoffChannelUnsetAlert,
  formatHandoffChannelUnsetRecovery,
  formatHandoffNotice,
  formatHandoffUndeliveredAlert,
  formatHandoffUndeliveredRecovery,
} from "@/lib/handoffs/copy";

/**
 * The monitor lane step that delivers and settles booking handoffs (#2367).
 *
 * Each tick, in this order:
 *
 *  1. ONE bounded read of the open rows, oldest first, and ONE read of the bookings
 *     they point at (a primary key lookup). Nothing is read per row.
 *  2. RESOLVE from measured state only. A duplicate is over once its booking is no
 *     longer active or has started; an owner refusal is over for the same reasons,
 *     or once the booking is assigned to the owner who was refused. A booking read
 *     that fails resolves nothing: an unreadable booking is not a cancelled one.
 *  3. DELIVER each open, unnotified row to the handoff channel, at most
 *     `HANDOFF_POSTS_PER_TICK` a tick, the rest waiting for the next. `notified_at`
 *     is stamped only after a post SUCCEEDED; a failed post records the attempt and a
 *     short reason on that row so the next tick retries it.
 *  4. SAY SO when the handoffs are not getting through, as two conditions on the
 *     alerts channel, each cleared only by a tick that measured it healthy.
 *
 * The lane holds its own lock, so two ticks never run this at once; the stamp is still
 * written only onto a row that has none, so an overlap could at worst post twice and
 * never lose one. At least once is the right side for a notice somebody has to act on.
 *
 * IO is injected and every call is contained, so a throwing dependency never throws
 * out of the step and every branch is driven offline by scripts/test-booking-handoffs.ts.
 */

/** alert_state keys, shared by the lane and the settings screen. */
export const HANDOFF_CHANNEL_UNSET_KEY = "handoff_channel_unset";
export const HANDOFF_UNDELIVERED_KEY = "handoff_undelivered";

/**
 * The bound on the open rows read each tick. Both writers are refusals on single
 * booking requests (a duplicate Slate would not cancel, an owner move it would not
 * make), so the open set is a handful at a time and a page this size means something
 * is badly wrong upstream. A read that fills it is reported as TRUNCATED, and a
 * truncated tick never clears a page, because an unseen row may be the stale one.
 */
export const OPEN_HANDOFF_READ_LIMIT = 200;

/**
 * Posts per tick. Each costs a Slack call plus its stamp write out of the invocation
 * the cron lanes on this schedule share, and a backlog this deep is already paging,
 * so draining it faster buys little. The rest go on the next tick.
 */
export const HANDOFF_POSTS_PER_TICK = 10;

/** How long a handoff may wait unposted before the alerts channel is told. */
export const HANDOFF_UNDELIVERED_AFTER_MS = 30 * 60_000;

/** A booking still in play. Mirrors `ACTIVE_BOOKING_STATUSES`, kept dependency free. */
const ACTIVE_STATUSES = new Set(["confirmed", "rescheduled"]);

export interface OpenHandoff {
  id: string;
  bookingId: string;
  kind: HandoffKind;
  /** The stored jsonb, read through `readOwnerDetail` / `readDuplicateDetail`. */
  detail: unknown;
  createdAt: string;
  notifiedAt: string | null;
  notifyAttempts: number;
  lastNotifyError: string | null;
}

export interface HandoffBooking {
  id: string;
  /**
   * The smoke canary's isolated bookings (#396). REQUIRED, not optional, so `tsc`
   * names every construction site: a field that defaulted to false would make a
   * forgotten read look like a real lead.
   *
   * THREE states since #2369. `null` is "Slate could not tell", which is what the
   * store reports for a booking whose BUCKET did not come back, since the bucket is
   * where the flag lives and `bookings` has no such column. It is a state of its own
   * because both defaults are wrong invisibly: `false` announces one of the canary's
   * bookings to the sales side, and `true` suppresses a real lead's handoff, which is
   * also held out of the waiting count below, so nothing would ever page about it.
   * An unknown flag is treated as NOT a test booking (the notice still goes out) and
   * is counted, so the uncertainty is loud rather than decided silently.
   */
  isTest: boolean | null;
  status: string;
  startsAt: string;
  timezone: string;
  assignedUserId: string | null;
  agentName: string | null;
  agentEmail: string | null;
  attendeeName: string | null;
}

export type HandoffResolution = "booking-not-active" | "booking-started" | "assigned-to-requested-owner";

/**
 * Whether a handoff is over, from the booking as it stands. Null means still open,
 * including every case where the answer cannot be read: no booking row, or a start
 * time that does not parse. Those stay open and keep asking, which is the safe side
 * for something a person has to act on.
 */
export function handoffResolution(
  handoff: OpenHandoff,
  booking: HandoffBooking | undefined,
  nowMs: number,
): HandoffResolution | null {
  if (!booking) return null;
  if (!ACTIVE_STATUSES.has(booking.status)) return "booking-not-active";
  const startsMs = parseStampMs(booking.startsAt);
  if (startsMs !== null && startsMs <= nowMs) return "booking-started";
  if (handoff.kind === "owner-reassign-refused") {
    const owner = readOwnerDetail(handoff.detail)?.requestedOwnerUserId ?? null;
    // Null never matches null: an owner Slate has no user for cannot be "now holding"
    // a booking that happens to have nobody assigned.
    if (owner !== null && booking.assignedUserId === owner) return "assigned-to-requested-owner";
  }
  return null;
}

export interface HandoffCheckDeps {
  nowMs: number;
  /** The open rows, oldest first, at most `limit`. Throws on a failed read. */
  loadOpen: (limit: number) => Promise<OpenHandoff[]>;
  /** The bookings with these ids. Throws on a failed read. */
  loadBookings: (ids: string[]) => Promise<HandoffBooking[]>;
  /** The handoff channel, or null when it is unset. Throws on a failed read. */
  loadChannel: () => Promise<string | null>;
  /** Mark these open rows resolved. Throws on a failed write. */
  resolve: (ids: string[], reason: HandoffResolution, atIso: string) => Promise<void>;
  post: (channel: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Stamp a row notified, only if it has no stamp yet. Throws on a failed write. */
  markNotified: (id: string, atIso: string) => Promise<void>;
  /** Record a failed post on a row. Throws on a failed write. */
  recordNotifyFailure: (id: string, attempts: number, reason: string) => Promise<void>;
  /** The admin booking page for a booking id, absolute. */
  bookingUrl: (bookingId: string) => string;
  /** The alert settings page, absolute, where the handoff channel is set. */
  settingsUrl: string;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  clearAlert: (key: string, text: string) => Promise<unknown>;
  cooldownMs: { channelUnset: number; undelivered: number };
  log?: (fields: Record<string, string | number | boolean>) => void;
  /** Something failed and was contained: a read, a write, a post's bookkeeping. */
  warn?: (fields: Record<string, string | number | boolean>) => void;
}

export interface HandoffCheckResult {
  /** False when the open rows could not be read: nothing below is a finding. */
  measured: boolean;
  /** Open rows read this tick. */
  open: number;
  /** The read filled its bound, so rows past it were not seen. */
  truncated: boolean;
  resolved: number;
  /** Measured over, and the write recording it failed. */
  resolveFailed: number;
  bookingsReadable: boolean;
  channel: "set" | "unset" | "unreadable";
  posted: number;
  postFailed: number;
  /** Posted, and the stamp could not be written, so the next tick may post it again. */
  stampFailed: number;
  /** Open rows held back because their booking is a test one (#2370). */
  suppressedTest: number;
  /**
   * Open rows whose booking's test flag could not be established (#2369). They are
   * DELIVERED, because withholding a real lead's handoff is the unrecoverable
   * direction, and counted here because a suppression decided by a read that did not
   * answer must not be silent.
   */
  testFlagUnknown: number;
  /** Open rows still unposted at the end of the tick. */
  waitingToPost: number;
  /** Of those, how many have waited past `HANDOFF_UNDELIVERED_AFTER_MS`. */
  undelivered: number;
}

const UNMEASURED: HandoffCheckResult = {
  measured: false,
  open: 0,
  truncated: false,
  resolved: 0,
  resolveFailed: 0,
  bookingsReadable: false,
  channel: "unreadable",
  posted: 0,
  postFailed: 0,
  stampFailed: 0,
  suppressedTest: 0,
  testFlagUnknown: 0,
  waitingToPost: 0,
  undelivered: 0,
};

/** Run a dependency, turning a throw into a value, so no single call ends the step. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function runHandoffCheck(deps: HandoffCheckDeps): Promise<HandoffCheckResult> {
  const nowIso = new Date(deps.nowMs).toISOString();
  const quietly = async (fn: () => Promise<unknown>) => {
    await attempt(fn);
  };

  const openRead = await attempt(() => deps.loadOpen(OPEN_HANDOFF_READ_LIMIT));
  if (!openRead.ok) {
    // Learned nothing, so it pages nothing and clears nothing (#1134, #1152).
    deps.warn?.({ msg: "open handoffs unreadable, no verdict this tick" });
    return UNMEASURED;
  }
  const open = openRead.value;
  const truncated = open.length >= OPEN_HANDOFF_READ_LIMIT;

  // --- 1. the bookings, and resolution from measured state ---------------------
  let bookingsReadable = true;
  const bookingById = new Map<string, HandoffBooking>();
  if (open.length > 0) {
    const read = await attempt(() => deps.loadBookings([...new Set(open.map((h) => h.bookingId))]));
    if (read.ok) for (const b of read.value) bookingById.set(b.id, b);
    else {
      bookingsReadable = false;
      deps.warn?.({ msg: "handoff bookings unreadable, nothing resolved or posted this tick" });
    }
  }

  /** Rows measured as over. Kept out of delivery even if the resolve write fails. */
  const over = new Set<string>();
  let resolved = 0;
  if (bookingsReadable) {
    const byReason = new Map<HandoffResolution, string[]>();
    for (const h of open) {
      const reason = handoffResolution(h, bookingById.get(h.bookingId), deps.nowMs);
      if (!reason) continue;
      over.add(h.id);
      byReason.set(reason, [...(byReason.get(reason) ?? []), h.id]);
    }
    // One write per reason, not one per row.
    for (const [reason, ids] of byReason) {
      const write = await attempt(() => deps.resolve(ids, reason, nowIso));
      if (write.ok) resolved += ids.length;
      else deps.warn?.({ msg: "resolve write failed", reason, rows: ids.length, error: shortFailureReason(errorText(write.error)) ?? "no detail" });
    }
  }

  // A row measured over is neither posted nor counted as waiting, even when its
  // resolve write failed: the situation it describes has ended, so there is nobody to
  // tell. The failed write is counted and logged, and the next tick measures it again.
  const resolveFailed = over.size - resolved;

  // --- 1b. handoffs about a TEST booking are never said out loud (#2370) ---------
  // The smoke canary books, reassigns and cancels on the isolated SMOKE agents every
  // six hours (#396), and the owner guard can refuse one of those moves. Without this
  // that refusal arrives in the sales channel as a lead waiting on a person. Every
  // other outward path suppresses `is_test` at its own choke point (webhooks at
  // `fire`, #459); this is that choke point for handoff delivery, and it is here
  // rather than at the WRITE because the row is still the truthful record of what
  // happened, and rather than in the booking READ because a handoff whose booking
  // never came back would then sit open and page as undelivered instead.
  //
  // A suppressed row is held out of delivery AND out of the waiting count, since
  // nothing is ever going to send it, and it settles on the same measured rules as
  // any other, which is what stops it sitting open for ever: the canary cancels its
  // bookings. It is COUNTED, so the suppression is never silent.
  //
  // A flag that could not be ESTABLISHED (#2369) is not a test booking. Compared
  // against `true` rather than read for truthiness, so the three states are decided
  // here rather than by what happens to be falsy, and the unknown ones are counted.
  const suppressed = new Set<string>();
  let testFlagUnknown = 0;
  for (const h of open) {
    if (over.has(h.id) || h.notifiedAt !== null) continue;
    const flag = bookingById.get(h.bookingId)?.isTest;
    if (flag === true) suppressed.add(h.id);
    else if (flag === null) testFlagUnknown++;
  }
  if (testFlagUnknown > 0) {
    deps.warn?.({
      msg: "handoff booking test flag unreadable, posting as a real lead",
      rows: testFlagUnknown,
    });
  }

  // --- 2. the channel ------------------------------------------------------------
  const channelRead = await attempt(() => deps.loadChannel());
  const channel: string | null | undefined = channelRead.ok
    ? channelRead.value && channelRead.value.trim()
      ? channelRead.value.trim()
      : null
    : undefined;
  if (!channelRead.ok) deps.warn?.({ msg: "handoff channel setting unreadable" });
  const channelState: HandoffCheckResult["channel"] =
    channel === undefined ? "unreadable" : channel === null ? "unset" : "set";

  // --- 3. delivery ---------------------------------------------------------------
  const delivered = new Set<string>();
  let posted = 0;
  let postFailed = 0;
  let stampFailed = 0;
  if (typeof channel === "string" && bookingsReadable) {
    const candidates = open
      .filter(
        (h) =>
          !over.has(h.id) &&
          !suppressed.has(h.id) &&
          h.notifiedAt === null &&
          bookingById.has(h.bookingId),
      )
      // Fewest failed attempts first, then oldest: a row that keeps failing must not
      // stand in front of every row behind it for ever.
      .sort(
        (a, b) =>
          a.notifyAttempts - b.notifyAttempts ||
          (parseStampMs(a.createdAt) ?? 0) - (parseStampMs(b.createdAt) ?? 0),
      )
      .slice(0, HANDOFF_POSTS_PER_TICK);
    for (const h of candidates) {
      const booking = bookingById.get(h.bookingId)!;
      const text = formatHandoffNotice(h, booking, deps.bookingUrl(h.bookingId));
      const reply = await attempt(() => deps.post(channel, text));
      const ok = reply.ok && reply.value.ok;
      if (!ok) {
        postFailed++;
        const raw = reply.ok ? (reply.value.error ?? "no reason given") : errorText(reply.error);
        const reason = shortFailureReason(raw) ?? "no reason given";
        const recorded = await attempt(() => deps.recordNotifyFailure(h.id, h.notifyAttempts + 1, reason));
        if (!recorded.ok) deps.warn?.({ msg: "notify failure write failed", handoff_id: h.id });
        // Stop at the first failure. It is usually Slack or the channel rather than
        // this message, so every further attempt spends budget to learn the same thing.
        break;
      }
      posted++;
      delivered.add(h.id);
      const stamp = await attempt(() => deps.markNotified(h.id, nowIso));
      if (!stamp.ok) {
        // Posted and unrecorded: the next tick will post it again. Stop, because a
        // write that failed here will fail for the next row too, and each further
        // post would become one more duplicate.
        stampFailed++;
        deps.warn?.({ msg: "notified stamp failed after a successful post", handoff_id: h.id });
        break;
      }
    }
  }

  // --- 4. the two conditions ------------------------------------------------------
  const waiting = open.filter(
    (h) => !over.has(h.id) && !suppressed.has(h.id) && h.notifiedAt === null && !delivered.has(h.id),
  );
  const ageMs = (h: OpenHandoff) => {
    const created = parseStampMs(h.createdAt);
    // An unreadable age is the fail safe side: treated as having waited too long.
    return created === null ? Number.POSITIVE_INFINITY : deps.nowMs - created;
  };
  const undelivered = waiting.filter((h) => ageMs(h) > HANDOFF_UNDELIVERED_AFTER_MS);
  const oldestWaitMs = (rows: OpenHandoff[]) => {
    const finite = rows.map(ageMs).filter((ms) => Number.isFinite(ms));
    return finite.length > 0 ? Math.max(...finite) : HANDOFF_UNDELIVERED_AFTER_MS;
  };

  if (channelState === "unset" && waiting.length > 0) {
    await quietly(() =>
      deps.notify(
        HANDOFF_CHANNEL_UNSET_KEY,
        deps.cooldownMs.channelUnset,
        formatHandoffChannelUnsetAlert({
          waiting: waiting.length,
          oldestWaitMs: oldestWaitMs(waiting),
          settingsUrl: deps.settingsUrl,
        }),
      ),
    );
  } else if (channelState === "set" || (waiting.length === 0 && !truncated)) {
    await quietly(() => deps.clearAlert(HANDOFF_CHANNEL_UNSET_KEY, formatHandoffChannelUnsetRecovery()));
  }

  if (undelivered.length > 0) {
    // With no channel set the unset page already says this, and names the fix: one
    // cause, one page (L36). It is not cleared either, since rows really are waiting.
    if (channelState !== "unset") {
      const lastError = undelivered.map((h) => h.lastNotifyError).find((e) => e) ?? null;
      await quietly(() =>
        deps.notify(
          HANDOFF_UNDELIVERED_KEY,
          deps.cooldownMs.undelivered,
          formatHandoffUndeliveredAlert({
            count: undelivered.length,
            oldestWaitMs: oldestWaitMs(undelivered),
            thresholdMs: HANDOFF_UNDELIVERED_AFTER_MS,
            lastError,
            settingsUrl: deps.settingsUrl,
          }),
        ),
      );
    }
  } else if (!truncated) {
    await quietly(() => deps.clearAlert(HANDOFF_UNDELIVERED_KEY, formatHandoffUndeliveredRecovery()));
  }

  const result: HandoffCheckResult = {
    measured: true,
    open: open.length,
    truncated,
    resolved,
    resolveFailed,
    bookingsReadable,
    channel: channelState,
    posted,
    postFailed,
    stampFailed,
    suppressedTest: suppressed.size,
    testFlagUnknown,
    waitingToPost: waiting.length,
    undelivered: undelivered.length,
  };
  deps.log?.({ msg: "tick", ...result });
  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
