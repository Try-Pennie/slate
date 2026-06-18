// Relative (not "@/") for the two VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { toE164 } from "../phone.ts";
import {
  bookingWindow,
  busyBlockFor,
  eventDescription,
  idempotencyKeyFor,
  selectAgent,
  type AssignResult,
  type BusyBlockInsert,
} from "./core.ts";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type {
  Booking,
  Bucket,
  EventType,
  RoutingTrace,
  User,
  WebhookEvent,
} from "@/lib/db/types";

/**
 * Booking orchestration (create / reschedule / cancel / complete), split out
 * from the IO so it's unit-testable. Every side effect — DB, Google Calendar,
 * webhooks, clock/random — is reached through the injected `BookingDeps`, so
 * `scripts/test-booking-orchestration.ts` drives the full flow with in-memory
 * fakes. `service.ts` binds `BookingDeps` to the real Supabase/Google/webhook
 * implementations. This module imports NO IO on purpose.
 */

export class SlotUnavailableError extends Error {
  constructor() {
    super("That time is no longer available. Please pick another slot.");
    this.name = "SlotUnavailableError";
  }
}

export interface CreateBookingInput {
  bucketCode: string;
  startIso: string;
  timezone: string;
  salesforceId?: string | null;
  attendee: { name?: string; email?: string; phone?: string };
  prefill: Record<string, string>;
  /** Optional caller-supplied key; falls back to a derived bucket+slot+attendee key. */
  idempotencyKey?: string;
}

export interface BookingResult {
  booking: Booking;
  manageUrl: string;
}

export interface CreateEventArgs {
  summary: string;
  description?: string;
  start: string;
  end: string;
  timezone: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

export type BookingInsert = {
  org_id: string;
  bucket_id: string;
  event_type_id: string;
  assigned_user_id: string;
  agent_name: string | null;
  agent_email: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: "confirmed";
  salesforce_id: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  prefill: Record<string, string>;
  gcal_event_id: string;
  manage_token: string;
  idempotency_key: string | null;
  routing_trace: RoutingTrace;
};

/**
 * insertBooking outcome. `conflict` means the active-slot unique index rejected
 * the row (23505) — another booking won the verify-on-book race for this
 * agent+slot; the caller turns it into SlotUnavailableError.
 */
export type InsertBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; conflict: boolean };

export type BookingUpdate = {
  starts_at?: string;
  ends_at?: string;
  assigned_user_id?: string | null;
  agent_name?: string | null;
  agent_email?: string | null;
  status?: Booking["status"];
  gcal_event_id?: string | null;
  allow_double_book?: boolean;
  routing_trace?: RoutingTrace | null;
};

export interface BookingContext {
  booking: Booking;
  bucket: Bucket;
  eventType: EventType;
}

/** Every side effect the orchestration needs. `service.ts` wires the real ones. */
export interface BookingDeps {
  // availability / routing
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  roundRobinCandidates(bucket: Bucket, eventType: EventType, startMs: number): Promise<string[]>;
  // google calendar
  isFree(email: string, startIso: string, endIso: string): Promise<boolean>;
  createEvent(email: string, args: CreateEventArgs): Promise<string>;
  deleteEvent(email: string, eventId: string): Promise<void>;
  updateEventTime(email: string, eventId: string, startIso: string, endIso: string, timezone: string): Promise<void>;
  // db
  getUser(userId: string): Promise<User>;
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  insertBooking(row: BookingInsert): Promise<InsertBookingResult>;
  insertBusyBlock(block: BusyBlockInsert): Promise<void>;
  deleteBusyBlocksForBooking(bookingId: string): Promise<void>;
  updateBooking(bookingId: string, patch: BookingUpdate): Promise<void>;
  /**
   * Batch-flips finished bookings to `completed`, returning the ids THIS call
   * actually transitioned. The update is gated on each row still being in a
   * completable status, so an overlapping cron tick that already completed some
   * of them won't re-fire their booking.completed (#163). One statement for the
   * whole batch instead of a round-trip per booking (#164).
   */
  completeBookingsIfDue(bookingIds: string[]): Promise<string[]>;
  /**
   * Reschedule idempotency lock. Claims (bookingId, target instant); returns
   * false when a concurrent reschedule to the same target already holds it, so
   * the loser of a double-submit no-ops. Stale locks (from a torn-down Worker)
   * are reclaimable. Released via `releaseReschedule` when the operation ends.
   */
  claimReschedule(bookingId: string, targetStartIso: string): Promise<boolean>;
  releaseReschedule(bookingId: string, targetStartIso: string): Promise<void>;
  loadBookingContext(token: string): Promise<BookingContext | null>;
  loadBookingById(bookingId: string): Promise<BookingContext | null>;
  getAgentByEmail(email: string): Promise<User | null>;
  loadPastBookingsToComplete(): Promise<BookingContext[]>;
  // webhooks + misc
  emitWebhook(orgId: string, event: WebhookEvent, payload: BookingEventPayload): Promise<void>;
  newManageToken(): string;
  appBaseUrl(): string;
  /** Best-effort clear of a bucket's cached availability after a booking changes it. */
  invalidateSlots(bucketCode: string): Promise<void>;
}

/**
 * Verify-on-book: walk the round-robin candidate order and do ONE live Google
 * free/busy check per candidate. First confirmed-free agent wins. Selection
 * core is `selectAgent` (pure/tested); this wires it to DB + Google.
 */
async function assignAgent(
  deps: BookingDeps,
  bucket: Bucket,
  eventType: EventType,
  startIso: string,
  endIso: string,
): Promise<AssignResult & { candidates: string[] }> {
  const candidates = await deps.roundRobinCandidates(
    bucket,
    eventType,
    Date.parse(startIso),
  );

  const result = await selectAgent(
    candidates,
    async (userId) => (await deps.getUser(userId)).email,
    (email) => deps.isFree(email, startIso, endIso),
  );
  if (!result) throw new SlotUnavailableError();
  return { ...result, candidates };
}

function webhookPayload(
  deps: BookingDeps,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
): BookingEventPayload {
  return {
    booking_id: booking.id,
    salesforce_id: booking.salesforce_id,
    bucket_code: bucket.code,
    event_type: eventType.name,
    event_type_slug: eventType.regal_type,
    event_description: eventType.description,
    status: booking.status,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    timezone: booking.timezone,
    // Read from the booking's agent snapshot, so it works even if the agent
    // was later removed from Slate.
    agent: {
      id: booking.assigned_user_id ?? "",
      name: booking.agent_name,
      email: booking.agent_email ?? "",
    },
    attendee: {
      name: booking.attendee_name,
      email: booking.attendee_email,
      phone: booking.attendee_phone,
    },
    prefill: booking.prefill,
    manage_url: `${deps.appBaseUrl()}/booking/manage/${booking.manage_token}`,
  };
}

async function fire(
  deps: BookingDeps,
  event: WebhookEvent,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
): Promise<void> {
  await deps.emitWebhook(
    booking.org_id,
    event,
    webhookPayload(deps, booking, bucket, eventType),
  );
}

function manageUrl(deps: BookingDeps, token: string): string {
  return `${deps.appBaseUrl()}/booking/manage/${token}`;
}

/**
 * Runs `task` over `items` with at most `limit` in flight at once. Keeps the
 * completion sweep's webhook fan-out from opening one connection per booking
 * (Cloudflare caps simultaneous subrequests), while still beating a fully
 * serial loop. Preserves input order in the returned results.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Max simultaneous booking.completed deliveries (Cloudflare subrequest cap). */
const COMPLETION_WEBHOOK_CONCURRENCY = 6;

export async function createBooking(
  input: CreateBookingInput,
  deps: BookingDeps,
): Promise<BookingResult> {
  const idempotencyKey =
    input.idempotencyKey ??
    idempotencyKeyFor({
      bucketCode: input.bucketCode,
      startIso: input.startIso,
      email: input.attendee.email,
      phone: input.attendee.phone,
      salesforceId: input.salesforceId,
    });

  // Fast path: a double-click / retry of the same submit returns the existing
  // active booking instead of creating a second one (+ a second gcal event).
  if (idempotencyKey) {
    const existing = await deps.findBookingByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { booking: existing, manageUrl: manageUrl(deps, existing.manage_token) };
    }
  }

  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new Error("Unknown booking bucket");
  const { bucket, eventType } = resolved;

  const { startIso, endIso } = bookingWindow(
    input.startIso,
    eventType.duration_min,
  );

  const { userId, email, candidates } = await assignAgent(
    deps,
    bucket,
    eventType,
    startIso,
    endIso,
  );

  // Snapshot the agent's identity so booking history survives agent deletion.
  const agent = await deps.getUser(userId);
  // Normalize once so the stored row and every webhook carry E.164.
  const phone = toE164(input.attendee.phone);

  // Minted before the event so the invite can carry the manage link.
  const manageToken = deps.newManageToken();

  const gcalEventId = await deps.createEvent(email, {
    summary: `${eventType.name}${
      input.attendee.name ? ` with ${input.attendee.name}` : ""
    }`,
    description: eventDescription(phone, manageUrl(deps, manageToken)),
    start: startIso,
    end: endIso,
    timezone: input.timezone,
    attendeeEmail: input.attendee.email,
    attendeeName: input.attendee.name,
  });
  const inserted = await deps.insertBooking({
    org_id: bucket.org_id,
    bucket_id: bucket.id,
    event_type_id: eventType.id,
    assigned_user_id: userId,
    agent_name: agent.name,
    agent_email: agent.email,
    starts_at: startIso,
    ends_at: endIso,
    timezone: input.timezone,
    status: "confirmed",
    salesforce_id: input.salesforceId ?? null,
    attendee_name: input.attendee.name ?? null,
    attendee_email: input.attendee.email ?? null,
    attendee_phone: phone,
    prefill: input.prefill,
    gcal_event_id: gcalEventId,
    manage_token: manageToken,
    idempotency_key: idempotencyKey,
    routing_trace: {
      bucket_code: input.bucketCode,
      bucket_id: bucket.id,
      considered: candidates,
      chosen_user_id: userId,
      // True when the only agent(s) considered were the bucket's fallback.
      fallback_applied:
        bucket.fallback_user_id != null &&
        candidates.length > 0 &&
        candidates.every((id) => id === bucket.fallback_user_id),
    },
  });

  if (!inserted.ok) {
    // Roll back the calendar event so we don't orphan a hold.
    await deps.deleteEvent(email, gcalEventId).catch(() => {});
    if (inserted.conflict) {
      // Either a concurrent duplicate of THIS submit won the idempotency race
      // (return their booking), or a different attendee took the slot first
      // (genuinely unavailable). Disambiguate by the idempotency key.
      if (idempotencyKey) {
        const winner = await deps.findBookingByIdempotencyKey(idempotencyKey);
        if (winner) {
          return { booking: winner, manageUrl: manageUrl(deps, winner.manage_token) };
        }
      }
      throw new SlotUnavailableError();
    }
    throw new Error("Failed to persist booking");
  }
  const booking = inserted.booking;

  // Write-through: the cache reflects this booking immediately.
  await deps.insertBusyBlock(busyBlockFor(userId, startIso, endIso, booking.id));
  await deps.invalidateSlots(bucket.code);

  await fire(deps, "booking.created", booking, bucket, eventType);

  return { booking, manageUrl: manageUrl(deps, manageToken) };
}

export async function rescheduleBooking(
  token: string,
  newStartIso: string,
  deps: BookingDeps,
): Promise<BookingResult> {
  const ctx = await deps.loadBookingContext(token);
  if (!ctx) throw new Error("Booking not found");
  const { booking, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

  const { startIso, endIso } = bookingWindow(
    newStartIso,
    eventType.duration_min,
  );

  // Idempotency guard 1 — sequential duplicate / no-op reschedule: if the
  // booking already sits at the requested instant (e.g. a double-click whose
  // first call already landed), there's nothing to move.
  if (Date.parse(booking.starts_at) === Date.parse(startIso)) {
    return { booking, manageUrl: manageUrl(deps, token) };
  }

  // Idempotency guard 2 — concurrent duplicate: claim a short-lived lock on
  // (booking, target). The loser of a simultaneous double-submit returns
  // without redoing the Google move or re-emitting booking.rescheduled.
  if (!(await deps.claimReschedule(booking.id, startIso))) {
    return { booking, manageUrl: manageUrl(deps, token) };
  }

  try {
    return await applyReschedule(deps, token, ctx, startIso, endIso);
  } finally {
    await deps.releaseReschedule(booking.id, startIso);
  }
}

async function applyReschedule(
  deps: BookingDeps,
  token: string,
  ctx: BookingContext,
  startIso: string,
  endIso: string,
): Promise<BookingResult> {
  const { booking, bucket, eventType } = ctx;
  const currentEmail = booking.agent_email;

  // Prefer keeping the same agent if they're free at the new time.
  let assigned: string | null = booking.assigned_user_id;
  let agentName = booking.agent_name;
  let agentEmail = booking.agent_email;
  if (currentEmail && (await deps.isFree(currentEmail, startIso, endIso))) {
    await deps.updateEventTime(
      currentEmail,
      booking.gcal_event_id!,
      startIso,
      endIso,
      booking.timezone,
    );
  } else {
    // Reassign via round-robin; create a fresh event, drop the old one.
    const next = await assignAgent(deps, bucket, eventType, startIso, endIso);
    assigned = next.userId;
    const newAgent = await deps.getUser(next.userId);
    agentName = newAgent.name;
    agentEmail = newAgent.email;
    if (currentEmail && booking.gcal_event_id) {
      await deps.deleteEvent(currentEmail, booking.gcal_event_id).catch(() => {});
    }
    const newEventId = await deps.createEvent(next.email, {
      summary: `${eventType.name}${
        booking.attendee_name ? ` with ${booking.attendee_name}` : ""
      }`,
      description: eventDescription(
        booking.attendee_phone,
        manageUrl(deps, token),
      ),
      start: startIso,
      end: endIso,
      timezone: booking.timezone,
      attendeeEmail: booking.attendee_email ?? undefined,
      attendeeName: booking.attendee_name ?? undefined,
    });
    await deps.updateBooking(booking.id, { gcal_event_id: newEventId });
    booking.gcal_event_id = newEventId;
  }

  if (!assigned) throw new SlotUnavailableError();

  await deps.updateBooking(booking.id, {
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled",
  });

  // Move the write-through busy block.
  await deps.deleteBusyBlocksForBooking(booking.id);
  await deps.insertBusyBlock(busyBlockFor(assigned, startIso, endIso, booking.id));
  await deps.invalidateSlots(bucket.code);

  const updated = {
    ...booking,
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled" as const,
  };
  await fire(deps, "booking.rescheduled", updated, bucket, eventType);

  return { booking: updated, manageUrl: manageUrl(deps, token) };
}

/**
 * Reassign a booking to a specific owning agent (the contact-owner override,
 * #9). The caller (an upstream automation) has already decided this lead should
 * stick to this agent, so this is FORCED: the agent is booked at the same time
 * even if busy. It's the ONLY path that double-books — the booking is marked
 * `allow_double_book` so the active-slot unique index lets it stack. Throws
 * "Booking not found" / "Agent not found or not bookable" for the caller to map.
 */
export async function reassignBooking(
  bookingId: string,
  agentEmail: string,
  deps: BookingDeps,
): Promise<BookingResult> {
  const ctx = await deps.loadBookingById(bookingId);
  if (!ctx) throw new Error("Booking not found");
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

  const agent = await deps.getAgentByEmail(agentEmail);
  if (!agent || !agent.bookable || !agent.email) {
    throw new Error("Agent not found or not bookable");
  }
  if (agent.id === booking.assigned_user_id) {
    return { booking, manageUrl: manageUrl(deps, booking.manage_token) };
  }

  // Move the calendar event to the owning agent at the same time. No free check:
  // this path intentionally double-books, gated only by `allow_double_book`.
  if (booking.agent_email && booking.gcal_event_id) {
    await deps.deleteEvent(booking.agent_email, booking.gcal_event_id).catch(() => {});
  }
  const newEventId = await deps.createEvent(agent.email, {
    summary: `${eventType.name}${
      booking.attendee_name ? ` with ${booking.attendee_name}` : ""
    }`,
    start: booking.starts_at,
    end: booking.ends_at,
    timezone: booking.timezone,
    attendeeEmail: booking.attendee_email ?? undefined,
    attendeeName: booking.attendee_name ?? undefined,
  });

  // Record the override on the trace so the viewer can show who reassigned whom.
  const reassignment = {
    from: booking.assigned_user_id,
    to: agent.id,
    at: new Date().toISOString(),
  };
  const nextTrace: RoutingTrace = booking.routing_trace
    ? {
        ...booking.routing_trace,
        reassignments: [...(booking.routing_trace.reassignments ?? []), reassignment],
      }
    : {
        bucket_code: bucket.code,
        bucket_id: bucket.id,
        considered: [],
        chosen_user_id: booking.assigned_user_id ?? "",
        fallback_applied: false,
        reassignments: [reassignment],
      };

  await deps.updateBooking(booking.id, {
    assigned_user_id: agent.id,
    agent_name: agent.name,
    agent_email: agent.email,
    gcal_event_id: newEventId,
    status: "rescheduled",
    allow_double_book: true,
    routing_trace: nextTrace,
  });

  await deps.deleteBusyBlocksForBooking(booking.id);
  await deps.insertBusyBlock(
    busyBlockFor(agent.id, booking.starts_at, booking.ends_at, booking.id),
  );

  const updated = {
    ...booking,
    assigned_user_id: agent.id,
    agent_name: agent.name,
    agent_email: agent.email,
    gcal_event_id: newEventId,
    status: "rescheduled" as const,
    allow_double_book: true,
    routing_trace: nextTrace,
  };
  await fire(deps, "booking.rescheduled", updated, bucket, eventType);
  return { booking: updated, manageUrl: manageUrl(deps, booking.manage_token) };
}

export async function cancelBooking(
  token: string,
  deps: BookingDeps,
): Promise<void> {
  const ctx = await deps.loadBookingContext(token);
  if (!ctx) throw new Error("Booking not found");
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled") return;

  if (booking.agent_email && booking.gcal_event_id) {
    await deps.deleteEvent(booking.agent_email, booking.gcal_event_id).catch(() => {});
  }

  await deps.deleteBusyBlocksForBooking(booking.id);
  await deps.invalidateSlots(bucket.code);
  await deps.updateBooking(booking.id, { status: "cancelled" });

  await fire(
    deps,
    "booking.cancelled",
    { ...booking, status: "cancelled" },
    bucket,
    eventType,
  );
}

/** Cron sweep: mark finished bookings complete and emit booking.completed. */
export async function completePastBookings(deps: BookingDeps): Promise<number> {
  const due = await deps.loadPastBookingsToComplete();
  if (due.length === 0) return 0;

  // One batched UPDATE for the whole sweep instead of a round-trip per booking
  // (#164). The returned ids are the rows THIS call actually flipped, so an
  // overlapping cron tick that already completed some of them won't re-fire
  // their booking.completed — the receiver can't dedupe a second delivery (#163).
  const transitioned = new Set(
    await deps.completeBookingsIfDue(due.map((d) => d.booking.id)),
  );
  const toFire = due.filter((d) => transitioned.has(d.booking.id));

  // Fan booking.completed out with bounded concurrency rather than a serial
  // await per booking — faster under a backlog, but capped so we don't blow
  // the Worker's simultaneous-connection ceiling.
  await mapWithConcurrency(
    toFire,
    COMPLETION_WEBHOOK_CONCURRENCY,
    ({ booking, bucket, eventType }) =>
      fire(
        deps,
        "booking.completed",
        { ...booking, status: "completed" },
        bucket,
        eventType,
      ),
  );
  return toFire.length;
}

export async function getBookingByToken(
  token: string,
  deps: BookingDeps,
): Promise<BookingContext | null> {
  try {
    return await deps.loadBookingContext(token);
  } catch {
    return null;
  }
}
