// Relative (not "@/") for the two VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { toE164 } from "../phone.ts";
import {
  bookingWindow,
  busyBlockFor,
  selectAgent,
  type AssignResult,
  type BusyBlockInsert,
} from "./core.ts";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type {
  Booking,
  Bucket,
  EventType,
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
};

export type BookingUpdate = {
  starts_at?: string;
  ends_at?: string;
  assigned_user_id?: string | null;
  agent_name?: string | null;
  agent_email?: string | null;
  status?: Booking["status"];
  gcal_event_id?: string | null;
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
  insertBooking(row: BookingInsert): Promise<Booking | null>;
  insertBusyBlock(block: BusyBlockInsert): Promise<void>;
  deleteBusyBlocksForBooking(bookingId: string): Promise<void>;
  updateBooking(bookingId: string, patch: BookingUpdate): Promise<void>;
  advanceRoundRobin(bucketId: string, userId: string): Promise<void>;
  loadBookingContext(token: string): Promise<BookingContext | null>;
  loadPastBookingsToComplete(): Promise<BookingContext[]>;
  // webhooks + misc
  emitWebhook(orgId: string, event: WebhookEvent, payload: BookingEventPayload): Promise<void>;
  newManageToken(): string;
  appBaseUrl(): string;
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
): Promise<AssignResult> {
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
  return result;
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

export async function createBooking(
  input: CreateBookingInput,
  deps: BookingDeps,
): Promise<BookingResult> {
  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new Error("Unknown booking bucket");
  const { bucket, eventType } = resolved;

  const { startIso, endIso } = bookingWindow(
    input.startIso,
    eventType.duration_min,
  );

  const { userId, email } = await assignAgent(
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

  const gcalEventId = await deps.createEvent(email, {
    summary: `${eventType.name}${
      input.attendee.name ? ` — ${input.attendee.name}` : ""
    }`,
    description: phone
      ? `Booked via Slate. Phone: ${phone}`
      : "Booked via Slate.",
    start: startIso,
    end: endIso,
    timezone: input.timezone,
    attendeeEmail: input.attendee.email,
    attendeeName: input.attendee.name,
  });

  const manageToken = deps.newManageToken();
  const booking = await deps.insertBooking({
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
  });

  if (!booking) {
    // Roll back the calendar event so we don't orphan a hold.
    await deps.deleteEvent(email, gcalEventId).catch(() => {});
    throw new Error("Failed to persist booking");
  }

  // Write-through: the cache reflects this booking immediately.
  await deps.insertBusyBlock(busyBlockFor(userId, startIso, endIso, booking.id));

  // Advance the round-robin pointer.
  await deps.advanceRoundRobin(bucket.id, userId);

  await fire(deps, "booking.created", booking, bucket, eventType);

  return {
    booking,
    manageUrl: `${deps.appBaseUrl()}/booking/manage/${manageToken}`,
  };
}

export async function rescheduleBooking(
  token: string,
  newStartIso: string,
  deps: BookingDeps,
): Promise<BookingResult> {
  const ctx = await deps.loadBookingContext(token);
  if (!ctx) throw new Error("Booking not found");
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

  const { startIso, endIso } = bookingWindow(
    newStartIso,
    eventType.duration_min,
  );

  const currentEmail = booking.agent_email;

  // Prefer keeping the same agent if they're free at the new time.
  let assigned: string | null = booking.assigned_user_id;
  let agentName = booking.agent_name;
  let agentEmail = booking.agent_email;
  let movedAgents = false;
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
    movedAgents = true;
    const newAgent = await deps.getUser(next.userId);
    agentName = newAgent.name;
    agentEmail = newAgent.email;
    if (currentEmail && booking.gcal_event_id) {
      await deps.deleteEvent(currentEmail, booking.gcal_event_id).catch(() => {});
    }
    const newEventId = await deps.createEvent(next.email, {
      summary: `${eventType.name}${
        booking.attendee_name ? ` — ${booking.attendee_name}` : ""
      }`,
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

  if (movedAgents) {
    await deps.advanceRoundRobin(bucket.id, assigned);
  }

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

  return {
    booking: updated,
    manageUrl: `${deps.appBaseUrl()}/booking/manage/${token}`,
  };
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

  let count = 0;
  for (const { booking, bucket, eventType } of due) {
    await deps.updateBooking(booking.id, { status: "completed" });
    await fire(
      deps,
      "booking.completed",
      { ...booking, status: "completed" },
      bucket,
      eventType,
    );
    count++;
  }
  return count;
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
