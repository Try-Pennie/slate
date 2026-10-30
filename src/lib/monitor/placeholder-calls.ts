/**
 * Calls on the placeholder advisor whose time has passed with no Regal call to the
 * customer (#4206, Phase 8 of milestone 75), reported as ONE summary for the Eastern day
 * (#4392, Dan 2026-10-29).
 *
 * A coordinator, or a program lead's own booking link (#4255), books a time when no real
 * advisor is free and the call goes on the placeholder (Marcia) as a `staff_placed`
 * booking. Nobody dials as the placeholder: every Regal journey on these events branches
 * on `slateGhostBooking` and sends the call straight to the pool at its time (docs/api.md,
 * the Regal contract). So the one way such a customer is left waiting is Regal never
 * calling them at all, and nothing in Slate would notice: the booking reads as an
 * ordinary booked call.
 *
 * WHAT COUNTS AS A CALL. Any row in `regal_call_outcomes` (#2944) for the customer's
 * Salesforce Lead, started from `PLACEHOLDER_CALL_EARLY_MS` before the booked start:
 * answered or not, an advisor or Regal's AI agent, either direction. The question is
 * whether Regal reached out, not whether the call went well. The match is on the Lead
 * id, never the phone, because the call feed deliberately stores no phone (Dan,
 * 2026-09-08 and 2026-10-01) and every placeholder call carries its Lead id.
 *
 * WHEN IT IS DUE. `PLACEHOLDER_CALL_GRACE_MS` after the booked END. Slate hears of a
 * call only when it COMPLETES (`call.completed`), so a call that started on time and
 * became a full conversation arrives about the booking's length after its start. The
 * grace covers the pool picking it up and the delivery.
 *
 * AN UNREADABLE FEED IS NOT "NO CALLS". A failed read measures nothing, pages nothing
 * and clears nothing. And a feed that has gone quiet (Regal stopped posting, or the
 * night has no calls at all) would read exactly like a missed customer, so a booking is
 * judged only once the feed has received SOME call, anybody's, after that booking's
 * due time: a positive control on the feed itself (L98). Until then it is
 * `feed-behind`, an explicit unknown, said apart in the page and never cleared over.
 *
 * ONE CONDITION FOR THE DAY (`placeholder_calls_unserved`). It lists every placeholder
 * call so far that Eastern day (`placeholderCallDay`, the day the placeholder limit counts
 * by) whose time passed with no Regal call, each booking a SUBJECT, so a new name in the
 * list posts at once under the repeat policy and an unchanged list is said again once a
 * day (`repeat-policy.ts`). A late call from yesterday the feed could only judge this
 * morning (it went quiet before the call was due) belongs to today's list, since nobody
 * was told of it yesterday. When a call leaves the list its ending is said in its own
 * words (L11), on the next post and in the all clear: a call found is the recovery; a
 * cancel, a move onto a real advisor and a move to a later time each say why no call is
 * owed; the day turning with no call is a stand down that says nothing was fixed; and a
 * booking that is gone says so. Which calls the last post named is read back from the
 * alert's own row (`postedConditionSubjects`).
 *
 * It replaced a condition per booking (`placeholder_call_unserved:<booking id>`). That
 * family is retired: nothing pages on it, and a page it left open is closed once, in words
 * saying the summary replaced it (`RETIRED_PLACEHOLDER_CALL_TEXT`).
 *
 * Test bucket bookings are left out the way the other booking monitors do it: the
 * candidate read is limited to the real buckets (`placeholder-calls-store.ts`).
 *
 * Pure apart from the injected reads and the dispatcher, so the node suite drives every
 * branch (scripts/test-placeholder-calls.ts).
 */
import { BUSINESS_ZONE } from "../booking/business-hours.ts";
import { placeholderDayStartMs, placeholderDaysBack } from "../booking/program-lead-times.ts";
import { formatSlotDay, formatSlotTime } from "../booking/slot-label.ts";
import { parseStampMs } from "../date/stamp.ts";
import { isLeadId, leadIdKey } from "../salesforce/lead-xbc.ts";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { BookingKind, BookingStatus } from "../db/types.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";

/** The one condition for the day (#4392). */
export const PLACEHOLDER_CALLS_ALERT_KEY = "placeholder_calls_unserved";

/**
 * The RETIRED per booking family (`placeholder_call_unserved:<booking id>`, #4206). Named
 * only so a page it left open can be closed; nothing pages on it.
 */
export const RETIRED_PLACEHOLDER_CALL_PREFIX = "placeholder_call_unserved";

/** What closes a page the retired family left open. */
export const RETIRED_PLACEHOLDER_CALL_TEXT =
  "This alert for one placeholder call is retired: calls on the placeholder with no Regal call are now " +
  "listed in one summary for the day. If this call is still owed one today, it is in that list.";

const MIN = 60_000;

/** How long after the booked END a call must have reached the feed. See the header. */
export const PLACEHOLDER_CALL_GRACE_MS = 15 * MIN;

/**
 * How early a call still counts as this booking's: 15 minutes before the start, the
 * same lower edge the show rule reads Regal calls from (docs/pilot-compare-report.md).
 */
export const PLACEHOLDER_CALL_EARLY_MS = 15 * MIN;


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

export type PlaceholderCallEnding = "reached" | "cancelled" | "moved-to-advisor" | "rescheduled" | "day-over" | "gone";

export interface PlaceholderCallSettlement {
  bookingId: string;
  ending: PlaceholderCallEnding;
  text: string;
}

/**
 * How a call the last post listed, and the list no longer holds, ended. Checked in this
 * order: a call found is the most useful thing to say and wins over everything but the
 * booking being gone; a cancel or a move then explains why no call is owed; a call whose
 * day has turned closes last. Null for a call still owed today that is off the list only
 * because the feed cannot judge it yet: no ending is invented for it.
 */
export function placeholderCallEnding(
  b: PlaceholderBookingRow | undefined,
  calls: PlaceholderCallRow[],
  nowMs: number,
  todayStartMs: number,
): PlaceholderCallEnding | null {
  if (!b) return "gone";
  if (firstCall(b, calls) !== null) return "reached";
  if (b.status === "cancelled") return "cancelled";
  if (b.kind !== "staff_placed") return "moved-to-advisor";
  const start = parseStampMs(b.starts_at);
  if (start !== null && start > nowMs) return "rescheduled";
  if (start !== null && start < todayStartMs) return "day-over";
  return null;
}

// ------------------------------------------------------------------- copy

function when(iso: string): string {
  return `${formatSlotDay(iso, BUSINESS_ZONE)} at ${formatSlotTime(iso, BUSINESS_ZONE)} ET`;
}

function clock(ms: number): string {
  return `${formatSlotTime(new Date(ms).toISOString(), BUSINESS_ZONE)} ET`;
}

/**
 * The page: every call so far today past its time with no Regal call, each by its Lead
 * id (an external id, safe to show; never the customer's contact details) and its booking
 * link, then the two things a person can do. Calls the feed cannot judge yet are counted
 * apart, and calls the last post named that have since left the list say how.
 */
export function formatPlaceholderCallsAlert(input: {
  unserved: PlaceholderBookingRow[];
  unknown: number;
  ended: PlaceholderCallSettlement[];
  bookingUrl: (id: string) => string;
}): string {
  const n = input.unserved.length;
  const lines = input.unserved.map((b) => {
    const lead = b.salesforce_id ? `Lead ${b.salesforce_id}` : "A call with no Lead id";
    return `• ${lead}, booked for ${when(b.starts_at)}: ${input.bookingUrl(b.id)}`;
  });
  const unknown =
    input.unknown > 0
      ? `\n${input.unknown} more past ${input.unknown === 1 ? "its" : "their"} time cannot be judged yet: the call feed has received nothing since ${input.unknown === 1 ? "it was" : "they were"} due.`
      : "";
  const ended = input.ended.length > 0 ? `\nNo longer listed:\n${input.ended.map((e) => `• ${e.text}`).join("\n")}` : "";
  return (
    `${n} placeholder ${n === 1 ? "call today is" : "calls today are"} past ${n === 1 ? "its" : "their"} time with no Regal call to the customer:\n` +
    `${lines.join("\n")}\n` +
    `Nobody dials as the placeholder: Regal should have sent each to the pool at its time, and the call feed ` +
    `has nothing for these Leads, answered or not, from 15 minutes before. Call each customer back from Regal, ` +
    `or open the manage link on the Lead's calBookingLink__c to move or cancel the call.` +
    unknown +
    ended
  );
}

/** The all clear: nothing is listed any more, and how each call the last post named ended. */
export function formatPlaceholderCallsAllClear(ended: PlaceholderCallSettlement[]): string {
  if (ended.length === 0) return "No placeholder call today is past its time without a Regal call.";
  return `No placeholder call is listed any more. How each one ended:\n${ended.map((e) => `• ${e.text}`).join("\n")}`;
}

export interface PlaceholderCallEndingInput {
  ending: PlaceholderCallEnding;
  bookingId: string;
  booking?: PlaceholderBookingRow;
  callMs?: number | null;
  callAi?: boolean;
  url?: string;
}

/** How a listed call ended. One sentence per ending, never one "resolved" (L11). */
export function formatPlaceholderCallEnding(s: PlaceholderCallEndingInput): string {
  const b = s.booking;
  const call = b ? `the placeholder call booked for ${when(b.starts_at)}` : `booking ${s.bookingId}`;
  const link = s.url ? ` ${s.url}` : "";
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
      // the time the list named.
      return b
        ? `A listed placeholder call was moved to ${when(b.starts_at)}, so it is watched again from then.${link}`
        : `A listed placeholder call was moved to a later time, so it is watched again from then.${link}`;
    case "day-over":
      return (
        `${cap(call)} ended its day with no Regal call to the customer, so it is no longer listed. Nothing was ` +
        `fixed. Check the Lead in Salesforce and reach the customer there.${link}`
      );
    case "gone":
      return `The booking ${s.bookingId} is no longer in Slate, so there is nothing left to watch.`;
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
      /** Bookings judged: yesterday's and today's placeholder calls still owed one. */
      judged: number;
      notDue: number;
      served: number;
      /** Judged unknown because the feed had nothing past their due time. */
      feedBehind: number;
      /** Due with no usable Lead id; by id, for the log. */
      noLeadId: string[];
      /** Listed: sent to the dispatcher, which decides whether it posts. */
      unserved: string[];
      /** How the calls the last post named, and the list no longer holds, ended. */
      settled: PlaceholderCallEnding[];
      /** Pages the retired per booking family left open, closed this tick. */
      retiredClosed: number;
    };

export interface PlaceholderCallDeps {
  /** Placeholder calls in the REAL buckets whose start is in [sinceIso, untilIso]. THROWS. */
  loadCandidates: (sinceIso: string, untilIso: string) => Promise<PlaceholderBookingRow[]>;
  /** The booking ids the condition's last post named; empty when it has none. THROWS. */
  loadListedIds: () => Promise<string[]>;
  /** Bookings by id; a missing one is gone. THROWS. */
  loadBookingsById: (ids: string[]) => Promise<PlaceholderBookingRow[]>;
  /** Calls for these Lead keys started at or after `sinceIso`. THROWS. */
  loadCalls: (leadKeys: string[], sinceIso: string) => Promise<PlaceholderCallRow[]>;
  /** The newest arrival in the call feed, or null when it holds nothing. THROWS. */
  feedNewestReceivedMs: () => Promise<number | null>;
  /** The feed's first arrival at or after `sinceIso`, anybody's, or null. THROWS. */
  feedFirstArrivalAfterMs: (sinceIso: string) => Promise<number | null>;
  /** Booking ids with a page the retired per booking family left open. THROWS. */
  loadRetiredFiringIds: () => Promise<string[]>;
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
 * that fails is logged and never stops the next one.
 */
export async function runPlaceholderCallCheck(deps: PlaceholderCallDeps): Promise<PlaceholderCallResult> {
  const { nowMs } = deps;
  const [today, yesterday] = placeholderDaysBack(nowMs, 2) as [string, string];
  const todayStartMs = placeholderDayStartMs(today);

  let candidates: PlaceholderBookingRow[];
  let listed: string[];
  let listedRows: PlaceholderBookingRow[];
  let calls: PlaceholderCallRow[];
  let feedNewest: number | null;
  let retired: string[];
  const carried = new Set<string>();
  try {
    [candidates, listed, feedNewest, retired] = await Promise.all([
      deps.loadCandidates(new Date(placeholderDayStartMs(yesterday)).toISOString(), new Date(nowMs).toISOString()),
      deps.loadListedIds(),
      deps.feedNewestReceivedMs(),
      deps.loadRetiredFiringIds(),
    ]);
    const candidateIds = new Set(candidates.map((b) => b.id));
    const elsewhere = listed.filter((id) => !candidateIds.has(id));
    listedRows = elsewhere.length === 0 ? [] : await deps.loadBookingsById(elsewhere);
    const all = [...candidates, ...listedRows];
    const keys = [...new Set(all.map(bookingLeadKey).filter((k): k is string => k !== null))];
    const starts = all.map((b) => parseStampMs(b.starts_at)).filter((ms): ms is number => ms !== null);
    calls =
      keys.length === 0 || starts.length === 0
        ? []
        : await deps.loadCalls(keys, new Date(Math.min(...starts) - PLACEHOLDER_CALL_EARLY_MS).toISOString());
    // A call from yesterday that is unserved belongs to TODAY's list only when the feed
    // could not have judged it yesterday: its first arrival after the call was due came
    // today. One judged yesterday was on yesterday's list, which the day turning ended.
    for (const b of candidates) {
      const start = parseStampMs(b.starts_at);
      if (start === null || start >= todayStartMs || !stillOwed(b)) continue;
      if (judgePlaceholderCall(b, calls, feedNewest, nowMs).kind !== "unserved") continue;
      const first = await deps.feedFirstArrivalAfterMs(new Date(placeholderCallDueMs(b)!).toISOString());
      if (first === null || first >= todayStartMs) carried.add(b.id);
    }
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  let notDue = 0;
  let served = 0;
  let feedBehind = 0;
  let judged = 0;
  const noLeadId: string[] = [];
  const unserved: PlaceholderBookingRow[] = [];
  for (const b of candidates) {
    if (!stillOwed(b)) continue;
    const start = parseStampMs(b.starts_at);
    // parse-ok: a start nobody can read cannot be put on a day; counted as not due.
    const isToday = start !== null && start >= todayStartMs;
    const v = judgePlaceholderCall(b, calls, feedNewest, nowMs);
    // Yesterday's calls count only while the feed may still owe them a verdict, or when
    // they are carried into today's list; the rest were yesterday's to report.
    if (!isToday && v.kind !== "feed-behind" && !carried.has(b.id)) continue;
    judged += 1;
    if (v.kind === "not-due") notDue += 1;
    else if (v.kind === "served") served += 1;
    else if (v.kind === "feed-behind") feedBehind += 1;
    else if (v.kind === "no-lead-id") noLeadId.push(b.id);
    else unserved.push(b);
  }

  const listedNow = new Set(unserved.map((b) => b.id));
  const byId = new Map([...candidates, ...listedRows].map((b) => [b.id, b]));
  const ended: PlaceholderCallSettlement[] = [];
  for (const id of listed) {
    if (listedNow.has(id)) continue;
    const b = byId.get(id);
    const ending = placeholderCallEnding(b, calls, nowMs, todayStartMs);
    if (ending === null) continue;
    const call = b ? firstCall(b, calls) : null;
    ended.push({
      bookingId: id,
      ending,
      text: formatPlaceholderCallEnding({ ending, bookingId: id, booking: b, callMs: call?.ms ?? null, callAi: call?.ai ?? false, url: deps.bookingUrl(id) }),
    });
  }

  const key = PLACEHOLDER_CALLS_ALERT_KEY;
  if (unserved.length > 0) {
    const text = formatPlaceholderCallsAlert({ unserved, unknown: feedBehind, ended, bookingUrl: deps.bookingUrl });
    await deps.notify(key, deps.cooldownMs, text, { subjects: unserved.map((b) => b.id) }).catch(logAlertSendFailure(key));
  } else if (feedBehind === 0) {
    // A measured day with nothing owed, and nothing the feed could still be owing: the
    // healthy result the all clear hangs off. Unknowns hold the page open.
    await deps.resolve(key, formatPlaceholderCallsAllClear(ended)).catch(logResolveFailure(key));
  }

  for (const id of retired) {
    const retiredKey = `${RETIRED_PLACEHOLDER_CALL_PREFIX}:${id}`;
    await deps.resolve(retiredKey, RETIRED_PLACEHOLDER_CALL_TEXT).catch(logResolveFailure(retiredKey));
  }

  return {
    status: "checked",
    judged,
    notDue,
    served,
    feedBehind,
    noLeadId,
    unserved: unserved.map((b) => b.id),
    settled: ended.map((e) => e.ending),
    retiredClosed: retired.length,
  };
}
