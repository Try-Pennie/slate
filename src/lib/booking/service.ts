import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import {
  resolveBucketByCode,
  roundRobinCandidates,
} from "@/lib/availability/service";
import {
  createEvent,
  deleteEvent,
  isFree,
  updateEventTime,
} from "@/lib/google/calendar";
import { emitWebhook } from "@/lib/webhooks/emit";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import { toE164 } from "@/lib/phone";
import type {
  Booking,
  Bucket,
  EventType,
  User,
  WebhookEvent,
} from "@/lib/db/types";

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

interface AssignResult {
  userId: string;
  email: string;
}

/**
 * Verify-on-book: walk the round-robin candidate order and do ONE live Google
 * free/busy check per candidate (not all N up front), impersonating each
 * agent's calendar via domain-wide delegation. First confirmed-free agent wins.
 */
async function assignAgent(
  bucket: Bucket,
  eventType: EventType,
  startIso: string,
  endIso: string,
): Promise<AssignResult> {
  const candidates = await roundRobinCandidates(
    bucket,
    eventType,
    Date.parse(startIso),
  );

  for (const userId of candidates) {
    const agent = await getUser(userId);
    if (!agent.email) continue;
    if (await isFree(agent.email, startIso, endIso)) {
      return { userId, email: agent.email };
    }
  }
  throw new SlotUnavailableError();
}

async function getUser(userId: string): Promise<User> {
  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();
  return data as User;
}

function webhookPayload(
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
    manage_url: `${appUrl()}/booking/manage/${booking.manage_token}`,
  };
}

async function fire(
  event: WebhookEvent,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
): Promise<void> {
  await emitWebhook(
    booking.org_id,
    event,
    webhookPayload(booking, bucket, eventType),
  );
}

export interface BookingResult {
  booking: Booking;
  manageUrl: string;
}

export async function createBooking(
  input: CreateBookingInput,
): Promise<BookingResult> {
  const resolved = await resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new Error("Unknown booking bucket");
  const { bucket, eventType } = resolved;

  const startIso = new Date(input.startIso).toISOString();
  const endIso = new Date(
    Date.parse(startIso) + eventType.duration_min * 60_000,
  ).toISOString();

  const { userId, email } = await assignAgent(
    bucket,
    eventType,
    startIso,
    endIso,
  );

  // Snapshot the agent's identity so booking history survives agent deletion.
  const agent = await getUser(userId);
  // Normalize once so the stored row and every webhook carry E.164.
  const phone = toE164(input.attendee.phone);

  const gcalEventId = await createEvent(email, {
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

  const manageToken = nanoid(24);
  const db = supabaseAdmin();
  const { data: bookingRow, error } = await db
    .from("bookings")
    .insert({
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
    })
    .select("*")
    .single();

  if (error || !bookingRow) {
    // Roll back the calendar event so we don't orphan a hold.
    await deleteEvent(email, gcalEventId).catch(() => {});
    throw new Error(`Failed to persist booking: ${error?.message}`);
  }
  const booking = bookingRow as Booking;

  // Write-through: the cache reflects this booking immediately.
  await db.from("busy_blocks").insert({
    user_id: userId,
    starts_at: startIso,
    ends_at: endIso,
    source: "slate",
    booking_id: booking.id,
  });

  // Advance the round-robin pointer.
  await db
    .from("buckets")
    .update({ rr_last_assigned_user_id: userId })
    .eq("id", bucket.id);

  await fire("booking.created", booking, bucket, eventType);

  return {
    booking,
    manageUrl: `${appUrl()}/booking/manage/${manageToken}`,
  };
}

async function loadByToken(token: string): Promise<{
  booking: Booking;
  bucket: Bucket;
  eventType: EventType;
}> {
  const db = supabaseAdmin();
  const { data: booking } = await db
    .from("bookings")
    .select("*")
    .eq("manage_token", token)
    .maybeSingle();
  if (!booking) throw new Error("Booking not found");

  const b = booking as Booking;
  const [{ data: bucket }, { data: eventType }] = await Promise.all([
    db.from("buckets").select("*").eq("id", b.bucket_id).single(),
    db.from("event_types").select("*").eq("id", b.event_type_id).single(),
  ]);
  return {
    booking: b,
    bucket: bucket as Bucket,
    eventType: eventType as EventType,
  };
}

export async function rescheduleBooking(
  token: string,
  newStartIso: string,
): Promise<BookingResult> {
  const { booking, bucket, eventType } = await loadByToken(token);
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

  const startIso = new Date(newStartIso).toISOString();
  const endIso = new Date(
    Date.parse(startIso) + eventType.duration_min * 60_000,
  ).toISOString();

  const db = supabaseAdmin();
  const currentEmail = booking.agent_email;

  // Prefer keeping the same agent if they're free at the new time.
  let assigned: string | null = booking.assigned_user_id;
  let agentName = booking.agent_name;
  let agentEmail = booking.agent_email;
  let movedAgents = false;
  if (currentEmail && (await isFree(currentEmail, startIso, endIso))) {
    await updateEventTime(
      currentEmail,
      booking.gcal_event_id!,
      startIso,
      endIso,
      booking.timezone,
    );
  } else {
    // Reassign via round-robin; create a fresh event, drop the old one.
    const next = await assignAgent(bucket, eventType, startIso, endIso);
    assigned = next.userId;
    movedAgents = true;
    const newAgent = await getUser(next.userId);
    agentName = newAgent.name;
    agentEmail = newAgent.email;
    if (currentEmail && booking.gcal_event_id) {
      await deleteEvent(currentEmail, booking.gcal_event_id).catch(() => {});
    }
    const newEventId = await createEvent(next.email, {
      summary: `${eventType.name}${
        booking.attendee_name ? ` — ${booking.attendee_name}` : ""
      }`,
      start: startIso,
      end: endIso,
      timezone: booking.timezone,
      attendeeEmail: booking.attendee_email ?? undefined,
      attendeeName: booking.attendee_name ?? undefined,
    });
    await db
      .from("bookings")
      .update({ gcal_event_id: newEventId })
      .eq("id", booking.id);
    booking.gcal_event_id = newEventId;
  }

  if (!assigned) throw new SlotUnavailableError();

  await db
    .from("bookings")
    .update({
      starts_at: startIso,
      ends_at: endIso,
      assigned_user_id: assigned,
      agent_name: agentName,
      agent_email: agentEmail,
      status: "rescheduled",
    })
    .eq("id", booking.id);

  // Move the write-through busy block.
  await db.from("busy_blocks").delete().eq("booking_id", booking.id);
  await db.from("busy_blocks").insert({
    user_id: assigned,
    starts_at: startIso,
    ends_at: endIso,
    source: "slate",
    booking_id: booking.id,
  });

  if (movedAgents) {
    await db
      .from("buckets")
      .update({ rr_last_assigned_user_id: assigned })
      .eq("id", bucket.id);
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
  await fire("booking.rescheduled", updated, bucket, eventType);

  return {
    booking: updated,
    manageUrl: `${appUrl()}/booking/manage/${token}`,
  };
}

export async function cancelBooking(token: string): Promise<void> {
  const { booking, bucket, eventType } = await loadByToken(token);
  if (booking.status === "cancelled") return;

  if (booking.agent_email && booking.gcal_event_id) {
    await deleteEvent(booking.agent_email, booking.gcal_event_id).catch(() => {});
  }

  const db = supabaseAdmin();
  await db.from("busy_blocks").delete().eq("booking_id", booking.id);
  await db
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", booking.id);

  await fire(
    "booking.cancelled",
    { ...booking, status: "cancelled" },
    bucket,
    eventType,
  );
}

/** Cron sweep: mark finished bookings complete and emit booking.completed. */
export async function completePastBookings(): Promise<number> {
  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();
  const { data: rows } = await db
    .from("bookings")
    .select("*")
    .in("status", ["confirmed", "rescheduled"])
    .lt("ends_at", nowIso)
    .limit(200);

  let count = 0;
  for (const row of (rows ?? []) as Booking[]) {
    await db
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", row.id);
    const [{ data: bucket }, { data: eventType }] = await Promise.all([
      db.from("buckets").select("*").eq("id", row.bucket_id).single(),
      db.from("event_types").select("*").eq("id", row.event_type_id).single(),
    ]);
    await fire(
      "booking.completed",
      { ...row, status: "completed" },
      bucket as Bucket,
      eventType as EventType,
    );
    count++;
  }
  return count;
}

export async function getBookingByToken(token: string): Promise<{
  booking: Booking;
  bucket: Bucket;
  eventType: EventType;
} | null> {
  try {
    return await loadByToken(token);
  } catch {
    return null;
  }
}
