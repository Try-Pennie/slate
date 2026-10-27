import type {
  BookingEventAction,
  BookingEventInitiator,
  BusySource,
} from "@/lib/db/types";
import { TEST_MODE_COPY } from "@/lib/booking/booker-copy";
import { CALL_COMES_FROM_PREFIX, callComesFrom, placeholderReplyLine } from "@/lib/booking/manage-copy";

/**
 * Pure, side-effect-free cores of the booking flow, split out from
 * `service.ts` (which does DB writes + live Google calls) so the decision
 * logic is deterministic and unit-testable. See `scripts/test-booking.ts`.
 */

/**
 * Thrown by a calendar write when the target event no longer exists on Google
 * (HTTP 404/410). Lives in this pure module so both the Google client (which
 * throws it) and the pure orchestration layer (which catches it to recreate the
 * event) can reference it without coupling to the Google stack. See #617.
 */
export class EventGone extends Error {
  constructor(label: string) {
    super(`${label}: event no longer exists on Google`);
    this.name = "EventGone";
  }
}

/**
 * Thrown when an insert with our own client id 409s and the event Google holds
 * under that id is CANCELLED (#3217). Google keeps a deleted event's id, so a
 * deterministic id whose event was deleted answers the next insert with a 409,
 * and adopting that id would confirm a booking with nothing on the agent's
 * calendar. A caller that can derive a fresh id answers this with one; every
 * other caller fails loudly, which is the honest outcome (L12).
 */
export class EventCancelledOnReuse extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(`events.insert: the event already holding id ${eventId} is cancelled on Google`);
    this.name = "EventCancelledOnReuse";
    this.eventId = eventId;
  }
}

/**
 * The id to adopt from the event Google returned for a client id that 409ed
 * (#3217): its id when it is live, and a refusal when it is cancelled. The one
 * judge, shared by the real client and the fakes that stand in for it.
 */
export function adoptableEventId(clientId: string, existing: { id?: string; status?: string }): string {
  if (!existing.id) throw new Error("Google did not return an event id on reuse");
  if (existing.status === "cancelled") throw new EventCancelledOnReuse(clientId);
  return existing.id;
}

/** How many fresh ids a create tries past a cancelled tombstone before it fails
 *  loudly (#3217). */
export const TOMBSTONE_FRESH_IDS = 3;

/**
 * The `n`th fresh id after `clientId` in its tombstone chain (#3217). Fixed, so
 * every retry of one request walks the same chain. `v` is the last base32hex
 * letter Google allows in an event id, and the digits are base32hex too, so a
 * valid id stays valid.
 */
export function freshEventId(clientId: string, n: number): string {
  return `${clientId}v${n}`;
}

/**
 * Create under `clientId`, walking its fresh id chain past every cancelled
 * tombstone (#3217). `tryCreate` inserts one id and THROWS `EventCancelledOnReuse`
 * when Google holds it as cancelled (a live one it adopts). A retry walks the same
 * chain, so it adopts the first live event an earlier attempt made on it. Returns
 * the id it created or adopted, which the caller must store rather than its own.
 *
 * `onFreshId` runs BEFORE each fresh id is inserted, so a caller that records the
 * id it is about to write (a reschedule pin, a reassign intent) records the new
 * one first. If it throws, nothing is inserted and the error is the caller's.
 * Every id a tombstone: the last `EventCancelledOnReuse` is thrown.
 */
export async function createWithFreshIdOnTombstone(
  clientId: string,
  tryCreate: (id: string) => Promise<string>,
  onFreshId?: (id: string) => Promise<void>,
): Promise<string> {
  let refused: EventCancelledOnReuse | null = null;
  for (let n = 0; n <= TOMBSTONE_FRESH_IDS; n++) {
    const id = n === 0 ? clientId : freshEventId(clientId, n);
    if (n > 0) await onFreshId?.(id);
    try {
      return await tryCreate(id);
    } catch (err) {
      if (!(err instanceof EventCancelledOnReuse)) throw err;
      refused = err;
    }
  }
  throw refused;
}

// ---------------------------------------------------------------------------
// Reschedule/cancel reason capture + history events (#326 / #300, ADR 0001).
// ---------------------------------------------------------------------------

/** A selectable reason: a stable analytics `code` + a human `label`. */
export interface ReasonOption {
  code: string;
  label: string;
  /**
   * A code only Slate itself writes (#2369). It is a real, valid reason and it is
   * rendered as a label in history, but it is never OFFERED: a lead picking "double
   * booking" from the manage page would tell Regal, through the cancellation reason
   * on the webhook, that Slate had resolved a duplicate call. Absent means false.
   */
  systemOnly?: boolean;
}

/** The actions that capture a reason: customer-facing reschedule/cancel + the
 *  manager reassign (#546). */
export type ReasonAction = "reschedule" | "cancel" | "reassign";

/** Max length of the free-text detail for the "other" option. */
export const REASON_DETAIL_MAX = 500;

/**
 * Reason options shown in the manage-link + admin pickers. Codes are STABLE
 * (the analytics dimension for the show-rate driver analysis, #325) — change
 * labels freely, but never repurpose a code. "other" reveals a free-text field.
 */
export const RESCHEDULE_REASONS: ReasonOption[] = [
  { code: "schedule_conflict", label: "Schedule conflict" },
  { code: "found_better_time", label: "Found a better time" },
  { code: "need_more_prep", label: "Need more time to prepare" },
  { code: "other", label: "Other" },
];

export const CANCEL_REASONS: ReasonOption[] = [
  { code: "no_longer_interested", label: "No longer interested" },
  { code: "got_help_elsewhere", label: "Already got help elsewhere" },
  { code: "booked_by_mistake", label: "Booked by mistake" },
  { code: "schedule_conflict", label: "Schedule conflict" },
  { code: "other", label: "Other" },
  // Written only by POST /api/bookings/cancel-duplicate (#2369). Last, and system
  // only, so it is never in a picker: see `systemOnly` above.
  { code: "double_booking", label: "Double booking", systemOnly: true },
  // Sent by Regal on POST /api/bookings/cancel when a lead opts out of their call by
  // replying to a Marcia text (#2940). System only for the same reason: a lead must
  // not be able to record a text opt out from the manage page.
  { code: "text_opt_out", label: "Opted out by text", systemOnly: true },
];

/**
 * Reasons a manager picks when reassigning a booking to a specific agent (#546).
 * `owner_reassignment` reuses the EXACT code the machine reassign API defaults to
 * (src/app/api/bookings/reassign/route.ts), so manual and automated reassigns
 * land in one analytics bucket. "other" reveals the free-text field.
 */
export const REASSIGN_REASONS: ReasonOption[] = [
  { code: "owner_reassignment", label: "Owner reassignment" },
  { code: "coverage", label: "Coverage (agent unavailable)" },
  { code: "escalation", label: "Escalation" },
  { code: "other", label: "Other" },
  // Written only by the reroute confirm (#3244): an admin correcting a booking's
  // bucket does not pick a reason, Slate records this one. System only, so it is
  // never offered in the reassign picker.
  { code: "bucket_correction", label: "Bucket correction", systemOnly: true },
];

/** Raw reason input from a request (untrusted). */
export interface ReasonInput {
  code?: string;
  detail?: string | null;
}

/** A validated reason ready to persist: a known code + detail only for "other". */
export interface ValidatedReason {
  code: string;
  detail: string | null;
}

export type ReasonValidation =
  | { ok: true; reason: ValidatedReason }
  | { ok: false; error: string };

/**
 * Validates a reschedule/cancel/reassign reason against a supplied option set.
 * MANDATORY (#326): a missing code is rejected; the code must be one of `allowed`;
 * the "other" code requires non-empty, length-capped free text. Detail on any
 * non-"other" code is discarded.
 *
 * `allowed` is the resolved option set the caller already has for the action, and
 * carries all the information validation needs, so `validateReason` no longer takes
 * the action itself (#346). The server passes active+retired (so an in-flight
 * submission for a just-retired code still confirms); the client passes the active
 * set it rendered. There is deliberately NO coded-default fallback: the caller must
 * supply the live set, or a silent default would reject an admin-added code. Pure:
 * server enforcement and the UI share it so they can't drift.
 */
export function validateReason(
  input: ReasonInput,
  allowed: ReasonOption[],
): ReasonValidation {
  const options = allowed;
  const code = (input.code ?? "").trim();
  if (!code) return { ok: false, error: "Please choose a reason." };
  if (!options.some((o) => o.code === code)) {
    return { ok: false, error: "That reason isn't a valid choice." };
  }
  if (code === "other") {
    const detail = (input.detail ?? "").trim();
    if (!detail) return { ok: false, error: "Please tell us a bit more." };
    if (detail.length > REASON_DETAIL_MAX) {
      return {
        ok: false,
        error: `Please keep it under ${REASON_DETAIL_MAX} characters.`,
      };
    }
    return { ok: true, reason: { code, detail } };
  }
  return { ok: true, reason: { code, detail: null } };
}

/**
 * Who performed an admin-initiated booking action (#549). `userId` is the REAL
 * accountable staff user; `actingAsUserId` is the user they acted as when
 * impersonating (null otherwise). Customer/system actions pass no actor at all.
 */
export interface BookingActor {
  userId: string;
  actingAsUserId?: string | null;
}

/** Inputs for building a booking_events history row (pure). */
export interface BookingEventDraft {
  bookingId: string;
  action: BookingEventAction;
  initiator: BookingEventInitiator;
  reason: ValidatedReason;
  /** The time the booking was scheduled for BEFORE this action (lead-time base). */
  fromStartsIso: string | null;
  /** The new time (reschedule); null for cancel. */
  toStartsIso: string | null;
  fromAgentUserId: string | null;
  toAgentUserId: string | null;
  /**
   * The staff user accountable for an admin-initiated action (#549): the real
   * signed-in user. null for customer/system actions. When an admin is acting via
   * impersonation, this is the REAL admin, and `actingAsUserId` is who they acted as.
   */
  actorUserId?: string | null;
  /** The impersonated user an admin acted as (#549); null when not impersonating. */
  actingAsUserId?: string | null;
  /** The booking's reschedule generation (#614); versions the dedupe key so an
   *  oscillation back to a used time gets its own row + webhook. Only set for
   *  'rescheduled' events; null/omitted for cancel/reassign. */
  rescheduleSeq?: number | null;
  /** The bucket a reroute moved the booking from and to (#3249); null otherwise. */
  fromBucketId?: string | null;
  toBucketId?: string | null;
  nowMs: number;
}

// A `type` (index signature) so it's assignable to the Supabase insert param.
export type BookingEventInsert = {
  booking_id: string;
  action: BookingEventAction;
  initiator: BookingEventInitiator;
  reason_code: string;
  reason_detail: string | null;
  from_starts_at: string | null;
  to_starts_at: string | null;
  from_agent_user_id: string | null;
  to_agent_user_id: string | null;
  actor_user_id: string | null;
  acting_as_user_id: string | null;
  lead_time_minutes: number | null;
  reschedule_seq: number | null;
  /** A reroute's bucket before and after (#3249, migration 0166); null otherwise. */
  from_bucket_id: string | null;
  to_bucket_id: string | null;
};

/**
 * Builds the append-only history row for a reschedule/cancel/reassign. The
 * signed `lead_time_minutes` is minutes between the (pre-action) appointment
 * time and now: positive = acted before the appointment, negative = after it.
 */
export function bookingEventFrom(d: BookingEventDraft): BookingEventInsert {
  const lead_time_minutes =
    d.fromStartsIso != null
      // parse-ok: a history column, never a gate. It is written from the booking's
      // own NOT NULL starts_at, and a NaN would land in the record as null rather
      // than deciding anything.
      ? Math.round((Date.parse(d.fromStartsIso) - d.nowMs) / 60_000)
      : null;
  return {
    booking_id: d.bookingId,
    action: d.action,
    initiator: d.initiator,
    reason_code: d.reason.code,
    reason_detail: d.reason.detail,
    from_starts_at: d.fromStartsIso,
    to_starts_at: d.toStartsIso,
    from_agent_user_id: d.fromAgentUserId,
    to_agent_user_id: d.toAgentUserId,
    actor_user_id: d.actorUserId ?? null,
    acting_as_user_id: d.actingAsUserId ?? null,
    lead_time_minutes,
    reschedule_seq: d.rescheduleSeq ?? null,
    from_bucket_id: d.fromBucketId ?? null,
    to_bucket_id: d.toBucketId ?? null,
  };
}

/** Normalized [start, end) window for a slot of `durationMin` minutes. */
export function bookingWindow(
  startIso: string,
  durationMin: number,
): { startIso: string; endIso: string } {
  const start = new Date(startIso).toISOString();
  // parse-ok: fails LOUD, not silently. `start` is the output of toISOString on
  // the line above, so it always parses; and an unparseable startIso would have
  // thrown a RangeError there before this line ever ran.
  const end = new Date(Date.parse(start) + durationMin * 60_000).toISOString();
  return { startIso: start, endIso: end };
}

export { bufferedWindow } from "./buffered-window";

/**
 * Stable idempotency key for a booking submission: same bucket + slot + attendee
 * identity → same key, so a double-clicked/retried submit dedupes to one booking.
 * Returns null when there's NO identity (no email/phone/salesforceId) — without
 * an identity we can't safely dedupe (two different anonymous people booking the
 * same slot must not collapse), so the active-slot unique index is the only guard.
 */
export function idempotencyKeyFor(parts: {
  bucketCode: string;
  startIso: string;
  email?: string;
  phone?: string;
  salesforceId?: string | null;
}): string | null {
  const email = parts.email?.trim().toLowerCase() ?? "";
  const phone = parts.phone?.replace(/\s+/g, "") ?? "";
  const sf = parts.salesforceId ?? "";
  if (!email && !phone && !sf) return null;
  const start = new Date(parts.startIso).toISOString();
  return [parts.bucketCode, start, email, phone, sf].join("|");
}

/**
 * Deterministic Google client event id for the intent-first create (#439 P4).
 * SHA-256 of `idempotencyKey:agentUserId`, hex-encoded (hex 0-9a-f ⊆ base32hex
 * 0-9a-v, so it's a valid Google client id) behind a "slate" prefix. Keyed on the
 * ASSIGNED AGENT: a retry that lands on the SAME agent reuses the event (Google
 * 409s the duplicate id), while a different agent gets a different id — a client
 * id is unique per calendar, so keying on the agent is what stops the
 * "same id on two calendars = duplicate event" failure. Async (Web Crypto on
 * Workers + Node).
 */
export async function deterministicEventId(
  idempotencyKey: string,
  agentUserId: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${idempotencyKey}:${agentUserId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `slate${hex}`;
}

export interface AssignResult {
  userId: string;
  email: string;
}

/**
 * Resolve an agent's calendar ids from the `agent_calendars` read, distinguishing
 * a FAILED read from a genuine empty (#314). A query error returns
 * `readFailed: true` so verify-on-book can skip the agent and alert, rather than
 * silently treating the error as "no calendars" and checking only the primary
 * calendar (which could miss a conflict on a secondary calendar and double-book).
 * An empty result with no error is a clean empty (e.g. pre-first-sync) and the
 * caller falls back to the primary calendar as before. Pure; the IO lives in
 * `service.ts`.
 */
export function calendarIdsFromResult(res: {
  data: { calendar_id: string }[] | null;
  error: unknown;
}): { readFailed: boolean; ids: string[] } {
  if (res.error) return { readFailed: true, ids: [] };
  return { readFailed: false, ids: (res.data ?? []).map((r) => r.calendar_id) };
}

/** Subset of a verify-on-book wave that's free, plus the ones we couldn't check. */
export interface VerifyResult {
  /** Emails confirmed free for the slot. */
  free: Set<string>;
  /** Emails whose free/busy could NOT be determined (read error / outage). */
  unverified: Set<string>;
}

/** Outcome of verify-on-book selection. */
export interface SelectionOutcome {
  /** The chosen agent, or null when none was free. */
  assignment: AssignResult | null;
  /**
   * Only meaningful when `assignment` is null: true if at least one candidate
   * could not be verified (read error / outage). Lets the caller distinguish a
   * genuinely-full slot (alert nobody) from a verify-on-book outage masquerading
   * as one (alert + retryable error) — #319.
   */
  anyUnverified: boolean;
  /** How many candidates were sent to the live check, across every wave (#3272).
   *  Set by `selectAgent`. */
  checked?: number;
}

/** A wave's live check, as `selectAgent` makes it (#3495). */
type WaveVerify = (emails: string[], ids: ReadonlyMap<string, string>) => Promise<VerifyResult>;

/**
 * One wave of `selectAgent`: its advisors' emails, in
 * round-robin order with the emailless dropped, then one live check handed each email's
 * advisor id (#3495), so the check reads their calendars by id. An empty wave makes no
 * check.
 */
async function checkWave(
  waveIds: string[],
  loadEmails: (userIds: string[]) => Promise<Map<string, string>>,
  verifyFree: WaveVerify,
): Promise<{ wave: AssignResult[]; free: Set<string>; unverified: boolean }> {
  const emailById = await loadEmails(waveIds);
  const wave: AssignResult[] = [];
  for (const userId of waveIds) {
    const email = emailById.get(userId);
    if (email) wave.push({ userId, email });
  }
  if (wave.length === 0) return { wave, free: new Set(), unverified: false };
  const { free, unverified } = await verifyFree(wave.map((c) => c.email), new Map(wave.map((c) => [c.email, c.userId])));
  return { wave, free, unverified: unverified.size > 0 };
}

/**
 * Verify-on-book selection: walk candidates in round-robin order, but verify a
 * WAVE of `batchSize` candidates per round-trip instead of one Google call per
 * candidate. Each wave is a single batched `verifyFree(emails)` call; the first
 * candidate in round-robin order confirmed free wins. Only advances to the next
 * wave when a whole wave is busy. This bounds verify-on-book latency to ~one
 * round-trip in the common case (a free agent in the first wave) and at most
 * ceil(N / batchSize) sequential waves worst case, instead of up to N serial
 * calls — the fix for a large agent pool (#167).
 *
 * `loadEmails` (batched userId -> email, skipping emailless) and `verifyFree`
 * (emails -> the free subset + the unverifiable subset) are injected so this
 * stays pure and testable without DB/Google. When no candidate is free, also
 * reports whether any candidate was unverifiable so the caller can tell a full
 * slot from an outage (#319).
 */
export async function selectAgent(
  candidates: string[],
  loadEmails: (userIds: string[]) => Promise<Map<string, string>>,
  /** Handed each wave's emails and, #3495, the advisor id each was read from (email to id). */
  verifyFree: WaveVerify,
  batchSize: number,
): Promise<SelectionOutcome> {
  let anyUnverified = false;
  let checked = 0;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const { wave, free, unverified } = await checkWave(candidates.slice(i, i + batchSize), loadEmails, verifyFree);
    checked += wave.length;
    anyUnverified ||= unverified;
    for (const candidate of wave) {
      if (free.has(candidate.email)) return { assignment: candidate, anyUnverified, checked };
    }
  }
  return { assignment: null, anyUnverified, checked };
}

/** Busy interval as returned by Google freeBusy (ISO start/end). */
export interface BusyInterval {
  start: string;
  end: string;
}

/**
 * Does any busy interval block the requested window, given that ONE interval —
 * the booking's OWN still-present event (#523) — should be ignored? A busy block
 * is a real conflict only if the part overlapping [startMs, endMs) falls OUTSIDE
 * `ignore`. Google may merge the own event with a genuinely adjacent one, so this
 * subtracts the ignored span precisely rather than dropping the whole merged
 * block — it never falsely frees a real conflict. Boundaries exclusive; pass no
 * `ignore` for a plain free check.
 */
export function hasBlockingBusy(
  busy: { start: string; end: string }[],
  startMs: number,
  endMs: number,
  ignore?: { start: string; end: string } | null,
): boolean {
  // parse-ok: this function FAILS CLOSED on an unreadable stamp, deliberately.
  // A NaN busy bound makes `os`/`oe` NaN, the `os >= oe` early-out false, and the
  // `ignore` subtraction false, so the block is reported as blocking: an
  // unreadable calendar entry can only ever make an agent look busy, never free.
  // An unreadable `ignore` span means the own-event exemption stops applying,
  // which also lands on the blocking side. Do not "simplify" the comparison order
  // here without rechecking that, the whole safety of the check rests on it.
  const igStart = ignore ? Date.parse(ignore.start) : NaN;
  const igEnd = ignore ? Date.parse(ignore.end) : NaN; // parse-ok: fails closed, see above
  return busy.some((b) => {
    const os = Math.max(Date.parse(b.start), startMs); // parse-ok: fails closed, see above
    const oe = Math.min(Date.parse(b.end), endMs); // parse-ok: fails closed, see above
    if (os >= oe) return false; // no overlap with [start, end)
    if (ignore && os >= igStart && oe <= igEnd) return false; // overlap lies entirely within the ignored event
    return true;
  });
}

/**
 * True when BOTH ends of a busy interval parse to finite epoch ms (#1171).
 *
 * The one place this pair of stamps is judged, so the parser and the overlap
 * test can never disagree about what "readable" means. An interval that fails
 * this is never trusted as free time: `Date.parse` gives NaN, every comparison
 * with NaN is false, and an overlap test that can never fire reads exactly like
 * an empty calendar.
 */
export function isReadableInterval(start: string, end: string): boolean {
  return Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end));
}

/**
 * Google caps a freeBusy query at 20 calendar `items` (verified live against the
 * production domain: 20 gives 0 errors, 21 gives `tooManyCalendarsRequested`), so
 * every caller chunks its calendar ids at this width.
 *
 * It lives in this pure module rather than beside one of its callers because BOTH
 * freeBusy readers now chunk: the bulk cross identity verifier in `service.ts` and
 * the single agent reader in `calendar.ts` (#2412). Two copies of one platform
 * limit drift, and the drift is silent in the worst direction: a reader that never
 * chunked answered `tooManyCalendarsRequested` as free time.
 */
export const FREEBUSY_MAX_ITEMS = 20;

/** Splits calendar ids into calls Google will accept whole. */
export function chunkCalendarIds(calendarIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < calendarIds.length; i += FREEBUSY_MAX_ITEMS) {
    chunks.push(calendarIds.slice(i, i + FREEBUSY_MAX_ITEMS));
  }
  return chunks;
}

/**
 * Map one agent's freeBusy rows to epoch-ms intervals, or NULL when ANY of them
 * is unreadable (#1171).
 *
 * Null is the caller's documented "could not tell" signal, which re-routes the
 * booking instead of keeping the agent on a slot nothing verified. Returning the
 * readable subset instead would be the fail-open answer: the unreadable block
 * would simply vanish, and vanished busy time reads as free time.
 */
export function busyIntervalsFromFreeBusy(
  rows: { start: string; end: string }[],
): { start: number; end: number }[] | null {
  const out: { start: number; end: number }[] = [];
  for (const b of rows) {
    if (!isReadableInterval(b.start, b.end)) return null;
    // parse-ok: both ends were just proven finite by isReadableInterval above.
    out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
  }
  return out;
}

/** Per-calendar outcome of a bulk freeBusy query: busy ranges or an error. */
export interface CalendarBusy {
  busy: BusyInterval[];
  /** True when this calendar could not be read (the slot must not be trusted). */
  error: boolean;
}

/**
 * Parses a Google freeBusy response into a per-calendar busy/error map, keyed by
 * the calendar ids that were REQUESTED. Any requested calendar that's absent from
 * the response, or that Google flagged with an `errors` entry (e.g. access denied,
 * `tooManyCalendarsRequested`), is marked `error: true` so the classifier never
 * assumes it free and risks a double-book (#167). Pure; the IO lives in
 * `calendar.ts`'s `freeBusyMany`.
 *
 * A busy entry we cannot READ counts as unread too (#1171): a missing or
 * unparseable start/end used to be dropped from the list, and a dropped busy
 * block is indistinguishable from free time. `Date.parse` on a bad stamp yields
 * NaN, and NaN compares false against BOTH slot boundaries, so the overlap test
 * downstream can never fire. This is the last check before a booking is made, so
 * an unreadable block marks the whole calendar unreadable and the agent is routed
 * to the accurate direct per-agent check instead.
 */
export function busyByCalendarFromResponse(
  calendarIds: string[],
  calendars:
    | Record<
        string,
        { busy?: { start?: string; end?: string }[]; errors?: unknown[] }
      >
    | undefined,
): Map<string, CalendarBusy> {
  const out = new Map<string, CalendarBusy>();
  const cals = calendars ?? {};
  for (const id of calendarIds) {
    const cal = cals[id];
    if (!cal || (cal.errors && cal.errors.length > 0)) {
      out.set(id, { busy: [], error: true });
      continue;
    }
    const busy: BusyInterval[] = [];
    let unreadable = false;
    for (const b of cal.busy ?? []) {
      if (!b.start || !b.end || !isReadableInterval(b.start, b.end)) {
        unreadable = true;
        break;
      }
      busy.push({ start: b.start, end: b.end });
    }
    if (unreadable) {
      out.set(id, { busy: [], error: true });
      continue;
    }
    out.set(id, { busy, error: false });
  }
  return out;
}

/**
 * Maps a bulk cross-identity freeBusy response back to per-agent availability
 * (#167). The single-call verifier queries many agents' calendars in one
 * `freeBusy` call keyed by calendar id; this pure step classifies each agent:
 *  - `free`: EVERY one of their calendars read cleanly AND none overlaps the slot.
 *  - busy (in neither set): all calendars read cleanly but at least one overlaps.
 *  - `needsFallback`: at least one of their calendars was missing from the
 *    response or returned an error — we can't tell, so the caller must do a
 *    direct per-agent check rather than risk a double-book by assuming free.
 * Boundaries are exclusive: a busy block starting exactly at the slot end (or
 * ending exactly at the slot start) does not overlap.
 */
export function freeAgentsFromBusy(
  agents: { email: string; calendarIds: string[] }[],
  busyByCalendar: Map<string, CalendarBusy>,
  startMs: number,
  endMs: number,
): { free: Set<string>; needsFallback: Set<string> } {
  const free = new Set<string>();
  const needsFallback = new Set<string>();

  for (const agent of agents) {
    if (agent.calendarIds.length === 0) {
      needsFallback.add(agent.email);
      continue;
    }
    let allClean = true;
    let anyOverlap = false;
    for (const calId of agent.calendarIds) {
      const entry = busyByCalendar.get(calId);
      if (!entry || entry.error) {
        allClean = false;
        break;
      }
      // #1171: an unreadable interval reaching here (the parser above already
      // marks its calendar error, so this is defence in depth) must NOT be
      // silently skipped by the overlap test. NaN < endMs is false and
      // NaN > startMs is false, so a bad stamp would read as "does not overlap",
      // i.e. as free. Treat it as unreadable and route the agent to the direct
      // per-agent check.
      if (entry.busy.some((b) => !isReadableInterval(b.start, b.end))) {
        allClean = false;
        break;
      }
      if (
        entry.busy.some(
          // parse-ok: the unreadable case was routed to needsFallback by the
          // isReadableInterval check directly above, so every interval reaching
          // this comparison parses.
          (b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs,
        )
      ) {
        anyOverlap = true;
      }
    }
    if (!allClean) needsFallback.add(agent.email);
    else if (!anyOverlap) free.add(agent.email);
  }

  return { free, needsFallback };
}

// A `type` (not `interface`) so it gains an implicit index signature and stays
// assignable to the Supabase client's `Record<string, unknown>` insert param.
export type BusyBlockInsert = {
  user_id: string;
  starts_at: string;
  ends_at: string;
  source: BusySource;
  booking_id: string;
};

/** The write-through busy block a Slate booking inserts into the cache. */
export function busyBlockFor(
  userId: string,
  startIso: string,
  endIso: string,
  bookingId: string,
): BusyBlockInsert {
  return {
    user_id: userId,
    starts_at: startIso,
    ends_at: endIso,
    source: "slate",
    booking_id: bookingId,
  };
}

/**
 * The invite's TITLE, which is the line the lead sees in their calendar for the
 * whole week before the call and on the day (#1421).
 *
 * One builder, because it was assembled inline at four separate call sites (the
 * booking, both reschedule paths and the reassign; the contact correction is a
 * fifth), and a payload with no single
 * place its shape can be seen is one where a difference between two of them is
 * invisible to a reader of either (L94). It is also what lets the invite copy be
 * READ before it ships, through `pnpm preview:booker`.
 *
 * #3376: it names BOTH people, the way cal.com's invite does ("Senior Loan
 * Advisor Call between David Menjivar and Brad Jones"), so the advisor sees who
 * the call is with, and the lead who will ring them, from the calendar view.
 *
 * Either name can be missing (a booking can arrive without the lead's, a profile
 * without the advisor's), and the title never trails a dangling word:
 *   - both:           "{type} between {advisor} and {lead}"
 *   - the lead only:  "{type} with {lead}", the shape before #3376
 *   - otherwise:      "{type}" alone. An advisor name with no lead is NOT written
 *     as "with {advisor}": on the advisor's own calendar that names the owner,
 *     and "with X" has always meant the lead, so flipping who X is by case would
 *     mislead whoever reads it.
 * A blank or whitespace name is a missing one.
 *
 * Named fields rather than positions, because both names are strings and a
 * transposed call would put the advisor where the lead belongs with nothing to
 * notice it (L455).
 */
export function eventSummary(names: {
  eventType: string;
  advisor: string | null;
  lead: string | null;
}): string {
  const advisor = names.advisor?.trim() || null;
  const lead = names.lead?.trim() || null;
  if (advisor && lead) return `${names.eventType} between ${advisor} and ${lead}`;
  if (lead) return `${names.eventType} with ${lead}`;
  return names.eventType;
}

/**
 * The invite's LOCATION: the lead's phone, written AS STORED (`+1XXXXXXXXXX`),
 * for the same reason the description's phone line is (#2616): the advisor taps
 * it to dial, and E.164 is the form a dialler handles most reliably (#3376). It is
 * what cal.com's invite shows after the time, so the advisor has the number
 * without opening the event.
 *
 * Null when the booking has no number, and the caller then sends NO location
 * rather than an empty one.
 */
export function eventLocation(phone: string | null | undefined): string | null {
  return phone?.trim() || null;
}

/**
 * The Google event description, shown on the lead's calendar invite: phone
 * (when present) plus the self-serve manage link - the invite is the lead's
 * only email, so the reschedule/cancel link must ride along (#64).
 *
 * The phone is written AS STORED (`+1XXXXXXXXXX`), deliberately unlike the
 * manage page, which formats it for reading (#2616). This line is read by the
 * advisor, who taps it to dial, and the E.164 form is the one a dialler hands off
 * most reliably; the manage page's sentence is read by the lead. The two differ on
 * purpose, so do not "fix" this one to match.
 */
export function eventDescription(
  phone: string | null,
  manageUrl: string,
  /**
   * A TEST booking's invite opens with the test line (#2660), so the event on
   * the tester's own calendar, and on the smoke agent's, says what it is without
   * being opened. The same sentence every other test surface carries, from the
   * one builder, never restated here (L41).
   */
  opts: {
    isTest: boolean;
    /**
     * The number the call will come FROM (#1334), when it is known. It is written
     * at lead creation plus about a minute, so the booking path does not wait on
     * it; the reminder lane refreshes the invite once it reads one. Absent or null
     * says nothing about a number.
     */
    callingNumber?: string | null;
    /**
     * A call on the placeholder advisor, Marcia (booking kind `staff_placed`, #4206).
     * Its invite comes from the placeholder seat, whose inbox nobody reads, so it ends
     * with the reply to our texts line and names no calling number, even a known one
     * (Dan, 2026-10-26: a text to that number reaches nobody). Absent is a routed call.
     */
    onPlaceholder?: boolean;
  } = { isTest: false },
): string {
  const lines = [bookedLine(phone), `${MANAGE_LINK_PREFIX}${manageUrl}`];
  if (opts.isTest) lines.unshift(TEST_MODE_COPY.line);
  if (opts.onPlaceholder) return [...lines, placeholderReplyLine("invite")].join("\n");
  return withCallingNumberLine(lines.join("\n"), opts.callingNumber ?? null);
}

const MANAGE_LINK_PREFIX = "Reschedule or cancel: ";
const BOOKED_PREFIX = "Booked via Pennie.";

/** The first line of a booking's invite: who booked it, and the number to dial. */
function bookedLine(phone: string | null): string {
  return phone ? `${BOOKED_PREFIX} Phone: ${phone}` : BOOKED_PREFIX;
}

/**
 * An invite description with the lead's phone line set, and NOTHING else changed
 * (#1334). A phone correction used to rebuild the whole description, which dropped
 * any line it did not know about: the calling number the reminder lane wrote, and the
 * reassign explanation (#969). It now edits the one line, so those survive.
 *
 * The line is replaced where it stands; an invite that has none (the reassign one)
 * gets it at the top, below the test line when there is one, which is where
 * `eventDescription` puts it.
 */
export function withPhoneLine(description: string, phone: string | null): string {
  const lines = description === "" ? [] : description.split("\n");
  const at = lines.findIndex((l) => l.startsWith(BOOKED_PREFIX));
  if (at !== -1) {
    lines[at] = bookedLine(phone);
    return lines.join("\n");
  }
  lines.splice(lines[0] === TEST_MODE_COPY.line ? 1 : 0, 0, bookedLine(phone));
  return lines.join("\n");
}

/**
 * An invite description with the calling number line set, and NOTHING else changed
 * (#1334). The reminder lane writes the number into an invite that may carry text
 * it did not compose, the reassign explanation (#969) above all, so it edits that
 * one line rather than rebuilding the description from what it knows.
 *
 * Any existing calling number line is removed first, so a changed number replaces
 * the old one rather than sitting beside it, and applying it twice changes nothing.
 * The new line goes just above the manage link when there is one, which is where
 * `eventDescription` puts it, and at the end otherwise. A null or unreadable number
 * leaves the description exactly as it was: no line is ever removed for want of a
 * replacement, because a stale number is fixed by a known one, not by silence.
 */
export function withCallingNumberLine(description: string, callingNumber: string | null): string {
  const line = callComesFrom(callingNumber);
  if (!line) return description;
  const kept = description === "" ? [] : description.split("\n").filter((l) => !l.startsWith(CALL_COMES_FROM_PREFIX));
  const at = kept.findIndex((l) => l.startsWith(MANAGE_LINK_PREFIX));
  if (at === -1) kept.push(line);
  else kept.splice(at, 0, line);
  return kept.join("\n");
}

/**
 * The completion sweep loads at most this many finished bookings per run and
 * completes them. It is the source of truth for the cap:
 * `loadPastBookingIdsToComplete` bounds its query by it, and the drain loop in
 * `completePastBookings` reads a full batch as more waiting (#223, #871).
 */
export const PAST_COMPLETION_BATCH_LIMIT = 200;

/**
 * The completion sweep drains its backlog by loading and completing successive
 * `PAST_COMPLETION_BATCH_LIMIT`-sized batches within one run, rather than
 * clearing only one batch per tick and letting the rest wait (#871, follow-up to
 * #223). This caps the loop so a run stays inside the Worker CPU/subrequest
 * budget (the sweep shares the every-5-minute invocation with the watch and
 * monitor lanes):
 * 25 batches = up to 5,000 bookings per run, ~2.5x a full day's volume at
 * current scale, and a larger backlog keeps draining over consecutive ticks.
 * When a run hits this cap with a full batch still pending, that is the
 * fail-loud signal that the backlog is outgrowing the sweep (warned in
 * `completePastBookings`), replacing #223's per-batch warn here.
 */
export const MAX_COMPLETION_DRAIN_BATCHES = 25;

/**
 * The fields that identify a FAILED booking insert (#1047).
 *
 * There is no booking id: the row was never written. So the joinable facts are the slot
 * and the agent, which is what ties the line to the confirm that produced it and to the
 * busy-block and calendar work around it.
 *
 * Pure and exported so the one rule that matters here is testable rather than a comment:
 * **no attendee data**. Contact data does not go in logs (docs/pii.md), and an error
 * path is exactly where somebody reaches for "log the whole row" while debugging.
 */
export function insertFailureLogFields(row: {
  bucket_id?: string | null;
  assigned_user_id?: string | null;
  starts_at?: string | null;
  gcal_event_id?: string | null;
}): Record<string, string | null> {
  return {
    bucket_id: row.bucket_id ?? null,
    user_id: row.assigned_user_id ?? null,
    starts_at: row.starts_at ?? null,
    gcal_event_id: row.gcal_event_id ?? null,
  };
}
