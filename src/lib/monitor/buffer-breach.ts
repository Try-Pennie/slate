import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { parseStampMs } from "@/lib/date/stamp";
import { doublingBand, type AlertRepeat } from "@/lib/notify/repeat-policy";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/**
 * Two active calls on one advisor closer than the call type's buffers (#3040).
 *
 * Production held 57 pairs of Slate bookings on one advisor with no time between
 * them. Every one was booked while the Senior Loan Advisor Call's buffers were still
 * 0 and 0; they became 10 and 10 by a hand edit on 2026-10-02, and nothing said that
 * the bookings already made under the old rule now broke the new one. No booking path
 * bypasses the buffers today (every offer and every confirm judges the buffered
 * window), but two things can still put calls inside one another's buffer on
 * purpose or by accident: a forced reassign, which sets `allow_double_book` to stack
 * a call on a busy advisor, and an event type's buffer raised under bookings that
 * already exist. So this measures the RESULT, whatever path produced it.
 *
 * A pair is two active calls on one advisor where the later one starts less than
 * max(earlier.buffer_after_min, later.buffer_before_min) minutes after the earlier
 * one ends. That is the same gap `bookableSlotReason` demands when it offers a time:
 * the earlier call's after buffer and the later call's before buffer both face the
 * gap, and the far side buffers do not. An outright overlap is a pair too, at any
 * buffer, and a gap EQUAL to the buffer is allowed, as it is when offering.
 *
 * Bookings in an `is_test` bucket are out of scope entirely. A pair where either call
 * carries `allow_double_book` was stacked on purpose, so it is FORCED: counted and
 * reported in the step's result, never paged. Everything else is a BREACH and pages.
 *
 * What it cannot see, said so a quiet run is not read as more: a call already in
 * progress (the read starts at now), anything past the booking horizon, a booking
 * with no assigned advisor (counted as `unassigned`), and a clash with a meeting on
 * the advisor's own calendar rather than another Slate booking, which is the busy
 * cache's job.
 */

export const BUFFER_BREACH_KEY = "booking_buffer_breach";

/** Pairs named in one page before the rest are summarised as a count. */
const PAIR_CAP = 10;

/** Forced pairs listed by id in the step's result, so the response stays small. */
const FORCED_LIST_CAP = 50;

const ALERT_ZONE = "America/New_York";
const MIN = 60_000;

/** One active booking, with what the judge needs and nothing else. */
export interface BufferedBooking {
  id: string;
  advisorId: string;
  /** The advisor's name as the booking stores it, for the page. Staff, never the lead. */
  advisorName: string | null;
  startsMs: number;
  endsMs: number;
  /** The booking's event type's buffers, in minutes. */
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** The booking's bucket is a test bucket. */
  inTestBucket: boolean;
  allowDoubleBook: boolean;
}

/** Two calls on one advisor closer than the buffers allow. */
export interface BufferPair {
  earlier: BufferedBooking;
  later: BufferedBooking;
  /** Minutes from the earlier call's end to the later call's start; negative for an overlap. */
  gapMin: number;
  /** Minutes the buffers required between them. */
  requiredMin: number;
}

export interface BufferJudgement {
  /** Every booking handed in, test ones included. */
  examined: number;
  /** Pairs that page: neither call forced, neither in a test bucket. */
  breaches: BufferPair[];
  /** Pairs where either call carries allow_double_book: counted, never paged. */
  forced: BufferPair[];
}

const byStart = (a: BufferedBooking, b: BufferedBooking) =>
  a.startsMs - b.startsMs || a.endsMs - b.endsMs || a.id.localeCompare(b.id);

/** Which pairs of bookings sit inside one another's buffer. Pure. */
export function judgeBufferBreaches(bookings: readonly BufferedBooking[]): BufferJudgement {
  const byAdvisor = new Map<string, BufferedBooking[]>();
  for (const b of bookings) {
    if (b.inTestBucket) continue;
    const list = byAdvisor.get(b.advisorId);
    if (list) list.push(b);
    else byAdvisor.set(b.advisorId, [b]);
  }
  const breaches: BufferPair[] = [];
  const forced: BufferPair[] = [];
  for (const advisorId of [...byAdvisor.keys()].sort()) {
    const calls = byAdvisor.get(advisorId)!.slice().sort(byStart);
    // Every pair, not only neighbours: a long call can overlap one two places on.
    // Bounded by one advisor's upcoming calls, a few dozen at most.
    for (let i = 0; i < calls.length; i++) {
      for (let j = i + 1; j < calls.length; j++) {
        const earlier = calls[i]!;
        const later = calls[j]!;
        // A booking is never in a pair with itself. One handed in twice (a read that
        // returned a row twice, 2026-10-25) would otherwise pair at minus its own
        // length and page as an overlap.
        if (earlier.id === later.id) continue;
        const gapMin = (later.startsMs - earlier.endsMs) / MIN;
        const requiredMin = Math.max(earlier.bufferAfterMin, later.bufferBeforeMin);
        if (gapMin >= requiredMin && gapMin >= 0) continue;
        const pair = { earlier, later, gapMin, requiredMin };
        if (earlier.allowDoubleBook || later.allowDoubleBook) forced.push(pair);
        else breaches.push(pair);
      }
    }
  }
  return { examined: bookings.length, breaches, forced };
}

/** The booking columns the check reads. */
export interface BufferBookingRow {
  id: string;
  assigned_user_id: string | null;
  agent_name: string | null;
  starts_at: string;
  ends_at: string;
  event_type_id: string;
  bucket_id: string;
  allow_double_book: boolean;
}

/**
 * The three reads joined into bookings the judge can take.
 *
 * A booking id returned twice THROWS, and so does a booking whose event type or
 * bucket the reads did not return. The event type and bucket are
 * foreign keys, so a miss means the read did not work as designed, and judging the
 * booking with a guessed zero buffer, or a guessed real or test bucket, would be an
 * answer built on nothing (L50).
 */
export function bookingsForBufferCheck(
  rows: readonly BufferBookingRow[],
  eventTypes: readonly { id: string; buffer_before_min: number; buffer_after_min: number }[],
  buckets: readonly { id: string; is_test: boolean }[],
): { bookings: BufferedBooking[]; unassigned: number } {
  const typeById = new Map(eventTypes.map((t) => [t.id, t]));
  const testById = new Map(buckets.map((b) => [b.id, b.is_test]));
  const bookings: BufferedBooking[] = [];
  let unassigned = 0;
  const ids = new Set<string>();
  for (const r of rows) {
    // One booking id twice means the read did not work as designed; judging it
    // would page the booking as overlapping itself (2026-10-25).
    if (ids.has(r.id)) throw new Error(`buffer breach: booking ${r.id} was returned twice by the read`);
    ids.add(r.id);
    if (!r.assigned_user_id) {
      unassigned++;
      continue;
    }
    const type = typeById.get(r.event_type_id);
    if (!type) throw new Error(`buffer breach: booking ${r.id} names event type ${r.event_type_id}, which the read did not return`);
    const isTest = testById.get(r.bucket_id);
    if (isTest === undefined) throw new Error(`buffer breach: booking ${r.id} names bucket ${r.bucket_id}, which the read did not return`);
    const startsMs = parseStampMs(r.starts_at);
    const endsMs = parseStampMs(r.ends_at);
    // An unreadable time cannot be judged, and NaN would compare as "no breach".
    if (startsMs === null || endsMs === null) {
      throw new Error(`buffer breach: booking ${r.id} has an unreadable start or end`);
    }
    bookings.push({
      id: r.id,
      advisorId: r.assigned_user_id,
      advisorName: r.agent_name,
      startsMs,
      endsMs,
      bufferBeforeMin: type.buffer_before_min,
      bufferAfterMin: type.buffer_after_min,
      inTestBucket: isTest,
      allowDoubleBook: r.allow_double_book,
    });
  }
  return { bookings, unassigned };
}

// ------------------------------------------------------------------ the copy

const when = (ms: number): string => {
  const iso = new Date(ms).toISOString();
  return `${formatSlotDay(iso, ALERT_ZONE)} at ${formatSlotTime(iso, ALERT_ZONE)} ET`;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function gapPhrase(p: BufferPair): string {
  if (p.gapMin < 0) return `overlapping by ${plural(-p.gapMin, "minute", "minutes")}`;
  if (p.gapMin === 0) return `back to back`;
  return `${plural(p.gapMin, "minute", "minutes")} apart`;
}

function pairLines(p: BufferPair, bookingUrl: (id: string) => string): string {
  const advisor = p.earlier.advisorName?.trim() || `advisor ${p.earlier.advisorId}`;
  return (
    `${advisor}: ${gapPhrase(p)}, where the buffers need ${plural(p.requiredMin, "minute", "minutes")} between them\n` +
    `  booking ${p.earlier.id}, ${when(p.earlier.startsMs)}\n  ${bookingUrl(p.earlier.id)}\n` +
    `  booking ${p.later.id}, ${when(p.later.startsMs)}\n  ${bookingUrl(p.later.id)}`
  );
}

/**
 * The page. Names each pair by booking id with the advisor and both times, never the
 * lead. The likely causes go in the runbook; the page says what to do.
 */
export function formatBufferBreachAlert(pairs: readonly BufferPair[], bookingUrl: (id: string) => string): string {
  const one = pairs.length === 1;
  const lines = pairs.slice(0, PAIR_CAP).map((p) => pairLines(p, bookingUrl));
  const more = pairs.length > PAIR_CAP ? `\n(and ${pairs.length - PAIR_CAP} more)` : "";
  const opening = one
    ? `2 upcoming calls on one advisor sit closer than the call type's buffer allows, and neither was ` +
      `stacked there on purpose. The advisor has no time between them, so move one of the two to ` +
      `another time or another advisor.`
    : `${pairs.length} pairs of upcoming calls sit closer than the call type's buffer allows, each pair on ` +
      `one advisor, and none was stacked there on purpose. Those advisors have no time between the two ` +
      `calls of each pair, so move one call of each pair to another time or another advisor.`;
  return `${opening}\n${lines.join("\n")}${more}`;
}

/** The all clear. Stands the reader down without repeating the remedy. */
export function formatBufferBreachRecovery(): string {
  return (
    `No advisor holds two upcoming calls closer than the call type's buffer any more. ` +
    `The calls behind the earlier page have been moved, cancelled or have passed. No action is needed.`
  );
}

const pairId = (p: BufferPair) => `${p.earlier.id}+${p.later.id}`;

/**
 * What the page names, for the repeat rule (#3801): one subject per pair, by both
 * booking ids, so a new pair posts at once and the same pairs are said again daily.
 */
export function bufferBreachRepeat(pairs: readonly BufferPair[]): AlertRepeat {
  return { subjects: pairs.map(pairId), band: doublingBand(pairs.length) };
}

// ---------------------------------------------------------------- the runner

/** What one tick measured. There is no unreadable state: a failed read throws. */
export interface BufferBreachResult {
  status: "measured";
  /** Active bookings in the window, test ones included. */
  examined: number;
  /** Active bookings with no assigned advisor, which pair with nothing. */
  unassigned: number;
  breaches: number;
  /** Pairs stacked on purpose (allow_double_book). Reported here, never paged. */
  forced: number;
  breachPairs: string[];
  /** The forced pairs by booking id, first FORCED_LIST_CAP of them. */
  forcedPairs: string[];
}

/**
 * One monitor tick: read, judge, page on a breach, settle the condition on a
 * measured zero.
 *
 * A failed read is NOT caught. It throws out of the check, so the monitor step fails,
 * returns its null fallback, and `monitor_step_failing:buffer_breach` speaks after a
 * sustained run of them. Catching it here would need a fallback value, and every
 * value this check could return reads as either "no breaches" or a number nobody
 * measured. The send and the all clear ARE caught: a failed Slack post must not
 * throw away what was measured.
 */
export async function runBufferBreachCheck(deps: {
  load: () => Promise<{ bookings: BufferedBooking[]; unassigned: number }>;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  bookingUrl: (id: string) => string;
}): Promise<BufferBreachResult> {
  const { bookings, unassigned } = await deps.load();
  const judged = judgeBufferBreaches(bookings);
  const result: BufferBreachResult = {
    status: "measured",
    examined: judged.examined + unassigned,
    unassigned,
    breaches: judged.breaches.length,
    forced: judged.forced.length,
    breachPairs: judged.breaches.map(pairId),
    forcedPairs: judged.forced.slice(0, FORCED_LIST_CAP).map(pairId),
  };
  if (judged.breaches.length > 0) {
    await deps
      .notify(
        BUFFER_BREACH_KEY,
        deps.cooldownMs,
        formatBufferBreachAlert(judged.breaches, deps.bookingUrl),
        bufferBreachRepeat(judged.breaches),
      )
      .catch(logAlertSendFailure(BUFFER_BREACH_KEY));
  } else {
    // A MEASURED zero: the read came back and judged every booking in the window.
    await deps.resolve(BUFFER_BREACH_KEY, formatBufferBreachRecovery()).catch(logResolveFailure(BUFFER_BREACH_KEY));
  }
  return result;
}
