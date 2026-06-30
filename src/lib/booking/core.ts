import type {
  Booking,
  BookingEventAction,
  BookingEventInitiator,
  Bucket,
  BusySource,
  EventType,
} from "@/lib/db/types";

/**
 * Pure, side-effect-free cores of the booking flow, split out from
 * `service.ts` (which does DB writes + live Google calls) so the decision
 * logic is deterministic and unit-testable. See `scripts/test-booking.ts`.
 */

// ---------------------------------------------------------------------------
// Reschedule/cancel reason capture + history events (#326 / #300, ADR 0001).
// ---------------------------------------------------------------------------

/** A selectable reason: a stable analytics `code` + a human `label`. */
export interface ReasonOption {
  code: string;
  label: string;
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
 * Validates a reschedule/cancel reason. MANDATORY (#326): a missing code is
 * rejected; the code must be one of the action's options; the "other" code
 * requires non-empty, length-capped free text. Detail on any non-"other" code
 * is discarded (only "other" carries free text). Pure — both the API (server
 * enforcement) and the UI use it, so they can't drift.
 */
export function validateReason(
  action: ReasonAction,
  input: ReasonInput,
): ReasonValidation {
  const optionsByAction: Record<ReasonAction, ReasonOption[]> = {
    reschedule: RESCHEDULE_REASONS,
    cancel: CANCEL_REASONS,
    reassign: REASSIGN_REASONS,
  };
  const options = optionsByAction[action];
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
};

/**
 * Builds the append-only history row for a reschedule/cancel/reassign. The
 * signed `lead_time_minutes` is minutes between the (pre-action) appointment
 * time and now: positive = acted before the appointment, negative = after it.
 */
export function bookingEventFrom(d: BookingEventDraft): BookingEventInsert {
  const lead_time_minutes =
    d.fromStartsIso != null
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
  };
}

/** Normalized [start, end) window for a slot of `durationMin` minutes. */
export function bookingWindow(
  startIso: string,
  durationMin: number,
): { startIso: string; endIso: string } {
  const start = new Date(startIso).toISOString();
  const end = new Date(Date.parse(start) + durationMin * 60_000).toISOString();
  return { startIso: start, endIso: end };
}

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
  verifyFree: (emails: string[]) => Promise<VerifyResult>,
  batchSize: number,
): Promise<SelectionOutcome> {
  let anyUnverified = false;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const waveIds = candidates.slice(i, i + batchSize);
    const emailById = await loadEmails(waveIds);
    // Preserve round-robin order; drop candidates with no resolvable email.
    const wave: AssignResult[] = [];
    for (const userId of waveIds) {
      const email = emailById.get(userId);
      if (email) wave.push({ userId, email });
    }
    if (wave.length === 0) continue;
    const { free, unverified } = await verifyFree(wave.map((c) => c.email));
    if (unverified.size > 0) anyUnverified = true;
    for (const candidate of wave) {
      if (free.has(candidate.email)) return { assignment: candidate, anyUnverified };
    }
  }
  return { assignment: null, anyUnverified };
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
  const igStart = ignore ? Date.parse(ignore.start) : NaN;
  const igEnd = ignore ? Date.parse(ignore.end) : NaN;
  return busy.some((b) => {
    const os = Math.max(Date.parse(b.start), startMs);
    const oe = Math.min(Date.parse(b.end), endMs);
    if (os >= oe) return false; // no overlap with [start, end)
    if (ignore && os >= igStart && oe <= igEnd) return false; // overlap lies entirely within the ignored event
    return true;
  });
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
    for (const b of cal.busy ?? []) {
      if (b.start && b.end) busy.push({ start: b.start, end: b.end });
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
      if (
        entry.busy.some(
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
 * The Google event description, shown on the lead's calendar invite: phone
 * (when present) plus the self-serve manage link - the invite is the lead's
 * only email, so the reschedule/cancel link must ride along (#64).
 */
export function eventDescription(
  phone: string | null,
  manageUrl: string,
): string {
  const lines = ["Booked via Pennie."];
  if (phone) lines[0] = `Booked via Pennie. Phone: ${phone}`;
  lines.push(`Reschedule or cancel: ${manageUrl}`);
  return lines.join("\n");
}

/**
 * Pairs each booking with its bucket + event type from already-fetched sets,
 * so the completion sweep can resolve them with two `.in()` queries instead of
 * a round-trip per booking (#164). A booking whose bucket or event type isn't
 * in the fetched set is dropped (FK integrity makes this unreachable in prod;
 * dropping is the safe choice if it ever happens).
 */
export function joinBookingContexts(
  bookings: Booking[],
  buckets: Bucket[],
  eventTypes: EventType[],
): { booking: Booking; bucket: Bucket; eventType: EventType }[] {
  const bucketById = new Map(buckets.map((b) => [b.id, b]));
  const eventTypeById = new Map(eventTypes.map((e) => [e.id, e]));

  const out: { booking: Booking; bucket: Bucket; eventType: EventType }[] = [];
  for (const booking of bookings) {
    const bucket = bucketById.get(booking.bucket_id);
    const eventType = eventTypeById.get(booking.event_type_id);
    if (bucket && eventType) out.push({ booking, bucket, eventType });
  }
  return out;
}
