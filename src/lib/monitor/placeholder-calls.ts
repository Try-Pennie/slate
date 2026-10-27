/**
 * A call on the placeholder advisor whose time has passed with no Regal call to the
 * customer (#4206, Phase 8 of milestone 75).
 *
 * A coordinator books the time a customer names; when no real advisor is free the call
 * goes on the placeholder (Marcia) as a `staff_placed` booking. Nobody dials as the
 * placeholder: every Regal journey on these events branches on `slateGhostBooking` and
 * sends the call straight to the pool at its time (docs/api.md, the Regal contract). So
 * the one way such a customer is left waiting is Regal never calling them at all, and
 * nothing in Slate would notice: the booking reads as an ordinary booked call.
 *
 * WHAT COUNTS AS A CALL. Any row in `regal_call_outcomes` (#2944) for the customer's
 * Salesforce Lead, started from `PLACEHOLDER_CALL_EARLY_MS` before the booked start:
 * answered or not, an advisor or Regal's AI agent, either direction. The question is
 * whether Regal reached out, not whether the call went well. The match is on the Lead
 * id, never the phone, because the call feed deliberately stores no phone (Dan,
 * 2026-09-08 and 2026-10-01) and every placeholder call carries its Lead id (the
 * coordinator page refuses one without, `placed-booking.ts`).
 *
 * WHEN IT IS DUE. `PLACEHOLDER_CALL_GRACE_MS` after the booked END. Slate hears of a
 * call only when it COMPLETES (`call.completed`), so a call that started on time and
 * became a full conversation arrives about the booking's length after its start. There
 * is no redistribution wait on top: Regal redistributes a routed call after the booked
 * advisor misses it, but a placeholder call goes to the pool at once. The grace covers
 * the pool picking it up and the delivery. A conversation running past the booking's
 * end and the grace pages once and recovers when it completes, which is the honest
 * cost of a feed that only reports finished calls.
 *
 * AN UNREADABLE FEED IS NOT "NO CALLS". A failed read measures nothing, pages nothing
 * and clears nothing. And a feed that has gone quiet (Regal stopped posting, or the
 * night has no calls at all) would read exactly like a missed customer, so a booking is
 * judged only once the feed has received SOME call, anybody's, after that booking's
 * due time: a positive control on the feed itself (L98). Until then it is
 * `feed-behind`, an explicit unknown. The feed's own health has its own alerts
 * (`regal_calls_quiet`, `regal_call_outcomes_short`).
 *
 * A CONDITION per booking (`placeholder_call_unserved:<booking id>`). Its endings never
 * share wording (L11): a call found is the recovery; a cancel, a move onto a real
 * advisor and a move to a later time each close it in their own words; and a page
 * still open `PLACEHOLDER_CALL_WATCH_MS` after the booked start closes as a stand down
 * that says nothing was fixed, before the per booking prune (7 days) would remove it
 * with no message at all. A read that fails or a feed that is behind ends nothing.
 *
 * Test bucket bookings are left out the way the other booking monitors do it: the
 * candidate read is limited to the real buckets (`placeholder-calls-store.ts`).
 *
 * Pure apart from the injected reads and the dispatcher, so the node suite drives every
 * branch (scripts/test-placeholder-calls.ts).
 */
import { BUSINESS_ZONE } from "../booking/business-hours.ts";
import { formatSlotDay, formatSlotTime } from "../booking/slot-label.ts";
import { parseStampMs } from "../date/stamp.ts";
import { isLeadId, leadIdKey } from "../salesforce/lead-xbc.ts";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { BookingKind, BookingStatus } from "../db/types.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";

/** The alert_state family: `placeholder_call_unserved:<booking id>`. */
export const PLACEHOLDER_CALL_ALERT_PREFIX = "placeholder_call_unserved";

export const placeholderCallAlertKey = (bookingId: string): string => `${PLACEHOLDER_CALL_ALERT_PREFIX}:${bookingId}`;

const MIN = 60_000;

/** How long after the booked END a call must have reached the feed. See the header. */
export const PLACEHOLDER_CALL_GRACE_MS = 15 * MIN;

/**
 * How early a call still counts as this booking's: 15 minutes before the start, the
 * same lower edge the show rule reads Regal calls from (docs/pilot-compare-report.md).
 */
export const PLACEHOLDER_CALL_EARLY_MS = 15 * MIN;

/**
 * How far back a NEW page can start, by booked start. A day: the lane runs every five
 * minutes, so a lane down for most of a day still pages on its return, and the read
 * stays a day's placeholder calls.
 */
export const PLACEHOLDER_CALL_LOOKBACK_MS = 24 * 60 * MIN;

/**
 * How long an open page is kept watching, by booked start. Three days: long enough for
 * a call back the next working day to close it as a recovery, and inside the seven days
 * after which the per booking prune would delete it silently
 * (`BOOKING_ALERT_PRUNE_GRACE_DAYS`, pinned by the suite).
 */
export const PLACEHOLDER_CALL_WATCH_MS = 3 * 24 * 60 * MIN;

/** A booking as this check reads it. */
export interface PlaceholderBookingRow {
  id: string;
  kind: BookingKind;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  /** The Lead id, 15 or 18 characters. */
  salesforce_id: string | null;
  /** The advisor's name, said when a move put the call on a real one. */
  agent_name: string | null;
}

/** One `regal_call_outcomes` row as this check reads it. */
export interface PlaceholderCallRow {
  lead_key: string;
  started_at: string;
  is_ai_agent: boolean;
}

export type PlaceholderCallVerdict =
  /** Its due time has not come. */
  | { kind: "not-due" }
  /** No usable Lead id, so no call can be matched to it. Logged by id, never paged. */
  | { kind: "no-lead-id" }
  /** The feed has received nothing since the due time, so absence proves nothing. */
  | { kind: "feed-behind" }
  /** A Regal call to the customer was found. */
  | { kind: "served"; callMs: number; ai: boolean }
  /** Due, the feed is alive past the due time, and no call to the customer. */
  | { kind: "unserved" };

const ACTIVE: ReadonlySet<BookingStatus> = new Set(["confirmed", "rescheduled", "completed"]);

/** The instant by which a call to this customer must have reached the feed, or null. */
export function placeholderCallDueMs(b: PlaceholderBookingRow): number | null {
  const start = parseStampMs(b.starts_at);
  const end = parseStampMs(b.ends_at);
  if (start === null) return null;
  return Math.max(start, end ?? start) + PLACEHOLDER_CALL_GRACE_MS;
}

/** The Lead key a booking's calls are filed under, or null when it has no Lead id. */
export function bookingLeadKey(b: Pick<PlaceholderBookingRow, "salesforce_id">): string | null {
  const id = b.salesforce_id?.trim() ?? "";
  return id !== "" && isLeadId(id) ? leadIdKey(id) : null;
}

/** The earliest call to the customer from just before the booked start, or null. */
function firstCall(b: PlaceholderBookingRow, calls: PlaceholderCallRow[]): { ms: number; ai: boolean } | null {
  const key = bookingLeadKey(b);
  const start = parseStampMs(b.starts_at);
  if (key === null || start === null) return null;
  let best: { ms: number; ai: boolean } | null = null;
  for (const c of calls) {
    if (c.lead_key !== key) continue;
    const ms = parseStampMs(c.started_at);
    if (ms === null || ms < start - PLACEHOLDER_CALL_EARLY_MS) continue;
    if (best === null || ms < best.ms) best = { ms, ai: c.is_ai_agent };
  }
  return best;
}

/**
 * Judge one booking. `feedNewestMs` is the newest arrival in the call feed, anybody's,
 * or null when the feed holds nothing.
 */
export function judgePlaceholderCall(
  b: PlaceholderBookingRow,
  calls: PlaceholderCallRow[],
  feedNewestMs: number | null,
  nowMs: number,
): PlaceholderCallVerdict {
  const due = placeholderCallDueMs(b);
  // parse-ok: an unreadable start is a booking nobody can judge, kept off the page and
  // counted by the caller as not due rather than guessed at.
  if (due === null || nowMs < due) return { kind: "not-due" };
  if (bookingLeadKey(b) === null) return { kind: "no-lead-id" };
  const call = firstCall(b, calls);
  if (call !== null) return { kind: "served", callMs: call.ms, ai: call.ai };
  if (feedNewestMs === null || feedNewestMs < due) return { kind: "feed-behind" };
  return { kind: "unserved" };
}

/** Whether a booking is still a placeholder call that Regal owes a call. */
function stillOwed(b: PlaceholderBookingRow): boolean {
  return b.kind === "staff_placed" && ACTIVE.has(b.status);
}

// ---------------------------------------------------------------- endings

export type PlaceholderCallEnding = "reached" | "cancelled" | "moved-to-advisor" | "rescheduled" | "stopped-watching" | "gone";

export interface PlaceholderCallSettlement {
  bookingId: string;
  ending: PlaceholderCallEnding;
  text: string;
}

/**
 * Which open pages have ENDED, and how. Checked in this order: a call found is the most
 * useful thing to say and wins over everything but the booking being gone; a cancel or
 * a move then explains why no call is owed; a page past the watch closes last. A page
 * whose booking is still owed a call, or whose feed is behind, stays open.
 */
export function settlePlaceholderCallAlerts(
  firingIds: string[],
  bookings: PlaceholderBookingRow[],
  calls: PlaceholderCallRow[],
  nowMs: number,
  bookingUrl: (id: string) => string,
): PlaceholderCallSettlement[] {
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const out: PlaceholderCallSettlement[] = [];
  for (const id of firingIds) {
    const b = byId.get(id);
    if (!b) {
      out.push({ bookingId: id, ending: "gone", text: formatPlaceholderCallEnding({ ending: "gone", bookingId: id }) });
      continue;
    }
    const url = bookingUrl(id);
    const call = firstCall(b, calls);
    const start = parseStampMs(b.starts_at);
    let ending: PlaceholderCallEnding | null = null;
    if (call !== null) ending = "reached";
    else if (b.status === "cancelled") ending = "cancelled";
    else if (b.kind !== "staff_placed") ending = "moved-to-advisor";
    else if (start !== null && start > nowMs) ending = "rescheduled";
    else if (start !== null && nowMs - start > PLACEHOLDER_CALL_WATCH_MS) ending = "stopped-watching";
    if (ending === null) continue;
    out.push({
      bookingId: id,
      ending,
      text: formatPlaceholderCallEnding({ ending, bookingId: id, booking: b, callMs: call?.ms ?? null, callAi: call?.ai ?? false, url }),
    });
  }
  return out;
}

// ------------------------------------------------------------------- copy

function when(iso: string): string {
  return `${formatSlotDay(iso, BUSINESS_ZONE)} at ${formatSlotTime(iso, BUSINESS_ZONE)} ET`;
}

function clock(ms: number): string {
  return `${formatSlotTime(new Date(ms).toISOString(), BUSINESS_ZONE)} ET`;
}

/**
 * The page. What happened, to whom (the Lead id, which is an external id and safe to
 * show; never the customer's contact details), and the two things a person can do.
 */
export function formatPlaceholderCallAlert(b: PlaceholderBookingRow, url: string): string {
  const lead = b.salesforce_id ? ` for Lead ${b.salesforce_id}` : "";
  return (
    `No Regal call has reached the customer on the placeholder call${lead} booked for ${when(b.starts_at)}. ` +
    `Nobody dials as the placeholder: Regal should have sent it to the pool at that time, and the call ` +
    `feed has nothing for this Lead, answered or not, from 15 minutes before it. Call the customer back ` +
    `from Regal, or open the manage link on the Lead's calBookingLink__c to move or cancel the call.\n${url}`
  );
}

export interface PlaceholderCallEndingInput {
  ending: PlaceholderCallEnding;
  bookingId: string;
  booking?: PlaceholderBookingRow;
  callMs?: number | null;
  callAi?: boolean;
  url?: string;
}

/** How a page ended. One sentence per ending, never one "resolved" (L11). */
export function formatPlaceholderCallEnding(s: PlaceholderCallEndingInput): string {
  const b = s.booking;
  const call = b ? `the placeholder call booked for ${when(b.starts_at)}` : `booking ${s.bookingId}`;
  const link = s.url ? `\n${s.url}` : "";
  switch (s.ending) {
    case "reached": {
      const start = b ? parseStampMs(b.starts_at) : null;
      const at = s.callMs != null ? clock(s.callMs) : "a time Regal did not send readably";
      const late =
        s.callMs != null && start !== null && s.callMs > start
          ? `, ${Math.round((s.callMs - start) / MIN)} minutes after the booked time`
          : "";
      const who = s.callAi ? "Regal's AI agent" : "Regal";
      return `${who} reached the customer on ${call}: a call at ${at}${late}.${link}`;
    }
    case "cancelled":
      return `${cap(call)} was cancelled, so no call is owed on it any more. Nothing says the customer was reached.${link}`;
    case "moved-to-advisor": {
      const name = b?.agent_name?.trim();
      return `${cap(call)} is now with ${name ? name : "a real advisor"}, so the call is theirs to make rather than the pool's.${link}`;
    }
    case "rescheduled":
      // The row holds the NEW start, so it is said as where the call went, never as
      // the time this alert was about.
      return b
        ? `The placeholder call this alert named was moved to ${when(b.starts_at)}, so it is watched again from then.${link}`
        : `The placeholder call this alert named was moved to a later time, so it is watched again from then.${link}`;
    case "stopped-watching":
      return (
        `${cap(call)} is more than 3 days past and no Regal call to the customer ever arrived, so it is no ` +
        `longer watched. Nothing was fixed. Check the Lead in Salesforce and reach the customer there.${link}`
      );
    case "gone":
      return `The booking this alert named (${s.bookingId}) is no longer in Slate, so there is nothing left to watch.`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------- runner

export type PlaceholderCallResult =
  /** A read failed: nothing measured, nothing paged, nothing cleared. */
  | { status: "unreadable"; error: string }
  | {
      status: "checked";
      /** Bookings judged: the window's placeholder calls and every open page still owed. */
      judged: number;
      notDue: number;
      served: number;
      /** Judged unknown because the feed had nothing past their due time. */
      feedBehind: number;
      /** Due with no usable Lead id; by id, for the log. */
      noLeadId: string[];
      /** Paged (or re-sent to the dispatcher, which decides whether it posts). */
      unserved: string[];
      settled: PlaceholderCallEnding[];
    };

export interface PlaceholderCallDeps {
  /** Placeholder calls in the REAL buckets whose start is in [sinceIso, untilIso]. THROWS. */
  loadCandidates: (sinceIso: string, untilIso: string) => Promise<PlaceholderBookingRow[]>;
  /** Booking ids with an open page in this family. THROWS. */
  loadFiringIds: () => Promise<string[]>;
  /** The bookings behind the open pages, by id; a missing one is gone. THROWS. */
  loadBookingsById: (ids: string[]) => Promise<PlaceholderBookingRow[]>;
  /** Calls for these Lead keys started at or after `sinceIso`. THROWS. */
  loadCalls: (leadKeys: string[], sinceIso: string) => Promise<PlaceholderCallRow[]>;
  /** The newest arrival in the call feed, or null when it holds nothing. THROWS. */
  feedNewestReceivedMs: () => Promise<number | null>;
  bookingUrl: (bookingId: string) => string;
  notify: ThrottledNotify<unknown>;
  /** REQUIRED, so the condition cannot be wired with no way to end (#1151). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

/**
 * The monitor lane step. Every read happens before anything is sent or cleared, so a
 * read that fails leaves the tick unmeasured with nothing half done. A send or resolve
 * that fails is logged per booking and never stops the next one.
 */
export async function runPlaceholderCallCheck(deps: PlaceholderCallDeps): Promise<PlaceholderCallResult> {
  const { nowMs } = deps;
  let candidates: PlaceholderBookingRow[];
  let firingRows: PlaceholderBookingRow[];
  let firing: string[];
  let calls: PlaceholderCallRow[];
  let feedNewest: number | null;
  try {
    [candidates, firing, feedNewest] = await Promise.all([
      deps.loadCandidates(new Date(nowMs - PLACEHOLDER_CALL_LOOKBACK_MS).toISOString(), new Date(nowMs).toISOString()),
      deps.loadFiringIds(),
      deps.feedNewestReceivedMs(),
    ]);
    firingRows = firing.length === 0 ? [] : await deps.loadBookingsById(firing);
    const all = [...candidates, ...firingRows];
    const keys = [...new Set(all.map(bookingLeadKey).filter((k): k is string => k !== null))];
    const starts = all.map((b) => parseStampMs(b.starts_at)).filter((ms): ms is number => ms !== null);
    calls =
      keys.length === 0 || starts.length === 0
        ? []
        : await deps.loadCalls(keys, new Date(Math.min(...starts) - PLACEHOLDER_CALL_EARLY_MS).toISOString());
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  const settlements = settlePlaceholderCallAlerts(firing, firingRows, calls, nowMs, deps.bookingUrl);
  for (const s of settlements) {
    const key = placeholderCallAlertKey(s.bookingId);
    await deps.resolve(key, s.text).catch(logResolveFailure(key));
  }
  const settledIds = new Set(settlements.map((s) => s.bookingId));

  // The window's calls and every open page still owed one, each judged once.
  const judgedById = new Map<string, PlaceholderBookingRow>();
  for (const b of [...candidates, ...firingRows]) {
    if (!settledIds.has(b.id) && stillOwed(b)) judgedById.set(b.id, b);
  }

  let notDue = 0;
  let served = 0;
  let feedBehind = 0;
  const noLeadId: string[] = [];
  const unserved: PlaceholderBookingRow[] = [];
  for (const b of judgedById.values()) {
    const v = judgePlaceholderCall(b, calls, feedNewest, nowMs);
    if (v.kind === "not-due") notDue += 1;
    else if (v.kind === "served") served += 1;
    else if (v.kind === "feed-behind") feedBehind += 1;
    else if (v.kind === "no-lead-id") noLeadId.push(b.id);
    else unserved.push(b);
  }

  for (const b of unserved) {
    const key = placeholderCallAlertKey(b.id);
    await deps
      .notify(key, deps.cooldownMs, formatPlaceholderCallAlert(b, deps.bookingUrl(b.id)), { subjects: [b.id] })
      .catch(logAlertSendFailure(key));
  }

  return {
    status: "checked",
    judged: judgedById.size,
    notDue,
    served,
    feedBehind,
    noLeadId,
    unserved: unserved.map((b) => b.id),
    settled: settlements.map((s) => s.ending),
  };
}
