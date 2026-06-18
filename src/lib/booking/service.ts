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
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { Booking, Bucket, EventType, User } from "@/lib/db/types";

const CACHE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// A reschedule finishes in seconds; this TTL only governs reclaiming a lock
// orphaned by a torn-down Worker, so keep it comfortably above the slowest run.
const RESCHEDULE_LOCK_TTL_MS = 2 * 60 * 1000;

/** Calendar ids whose busy blocks an agent, looked up by their email. */
async function calendarIdsForEmail(email: string): Promise<string[]> {
  const db = supabaseAdmin();
  const { data: user } = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (!user) return [];
  const { data } = await db
    .from("agent_calendars")
    .select("calendar_id")
    .eq("user_id", (user as { id: string }).id);
  return (data ?? []).map((r) => (r as { calendar_id: string }).calendar_id);
}
import { invalidateBucketSlots } from "@/lib/availability/slot-cache";
import { joinBookingContexts } from "@/lib/booking/core";
import * as orchestration from "@/lib/booking/orchestration";
import type {
  BookingContext,
  BookingDeps,
  BookingResult,
  CreateBookingInput,
} from "@/lib/booking/orchestration";

export { SlotUnavailableError } from "@/lib/booking/orchestration";
export type { BookingResult, CreateBookingInput };

/**
 * Binds the booking orchestration to real IO. This is the ONLY place the
 * booking flow touches Supabase, Google Calendar, or webhooks; the logic lives
 * in `orchestration.ts` and is exercised by `scripts/test-booking-orchestration.ts`.
 */
function realDeps(): BookingDeps {
  return {
    resolveBucketByCode,
    roundRobinCandidates,
    // Verify-on-book checks ALL the agent's calendars (falls back to primary
    // before the first sync has populated agent_calendars).
    isFree: async (email, startIso, endIso) => {
      const ids = await calendarIdsForEmail(email);
      return isFree(email, startIso, endIso, ids.length ? ids : ["primary"]);
    },
    createEvent,
    deleteEvent,
    updateEventTime,
    emitWebhook,
    appBaseUrl: appUrl,
    newManageToken: () => nanoid(24),
    invalidateSlots: (bucketCode) => invalidateBucketSlots(bucketCode),

    getUser: async (userId) => {
      const { data } = await supabaseAdmin()
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();
      return data as User;
    },

    findBookingByIdempotencyKey: async (key) => {
      // Active only — matches the partial unique index, so a cancelled booking
      // never blocks (or gets returned for) a fresh rebook of the same slot.
      const { data } = await supabaseAdmin()
        .from("bookings")
        .select("*")
        .eq("idempotency_key", key)
        .in("status", ["confirmed", "rescheduled"])
        .maybeSingle();
      return (data as Booking | null) ?? null;
    },

    insertBooking: async (row) => {
      const { data, error } = await supabaseAdmin()
        .from("bookings")
        .insert(row)
        .select("*")
        .single();
      if (error || !data) {
        // 23505 = unique_violation: the active-slot index rejected a racing
        // double-book. Surface it as a conflict (→ SlotUnavailableError).
        const conflict = error?.code === "23505";
        if (!conflict) console.error("insertBooking failed:", error?.message);
        return { ok: false, conflict };
      }
      return { ok: true, booking: data as Booking };
    },

    // The booking/cancel itself already succeeded when these run, so a cache
    // write failure must not fail the request - but it cannot stay silent
    // either (#34): a missed insert lets the embed keep offering a booked
    // slot until sync mirrors the Google event (~1 min); a missed delete
    // leaves phantom busy forever (slate rows have no gcal event to reconcile
    // against). Retry once, then log + throttled Slack alert.
    insertBusyBlock: async (block) => {
      let { error } = await supabaseAdmin().from("busy_blocks").insert(block);
      if (error) {
        ({ error } = await supabaseAdmin().from("busy_blocks").insert(block));
      }
      if (error) {
        console.error(
          `busy_blocks write-through insert failed for booking ${block.booking_id}: ${error.message}`,
        );
        await sendThrottledAlert(
          "busy_block_write_through",
          CACHE_ALERT_COOLDOWN_MS,
          `Slate: busy_blocks write-through INSERT failed for booking ${block.booking_id} (${error.message}). The slot may show as free in the embed until the next sync pass.`,
        ).catch(() => {});
      }
    },

    deleteBusyBlocksForBooking: async (bookingId) => {
      const del = () =>
        supabaseAdmin().from("busy_blocks").delete().eq("booking_id", bookingId);
      let { error } = await del();
      if (error) {
        ({ error } = await del());
      }
      if (error) {
        console.error(
          `busy_blocks write-through delete failed for booking ${bookingId}: ${error.message}`,
        );
        await sendThrottledAlert(
          "busy_block_write_through",
          CACHE_ALERT_COOLDOWN_MS,
          `Slate: busy_blocks DELETE failed for booking ${bookingId} (${error.message}). The cancelled slot will keep showing as busy until cleaned up.`,
        ).catch(() => {});
      }
    },

    updateBooking: async (bookingId, patch) => {
      await supabaseAdmin().from("bookings").update(patch).eq("id", bookingId);
    },

    completeBookingsIfDue: async (bookingIds) => {
      if (bookingIds.length === 0) return [];
      // One batched UPDATE for the whole sweep (#164). Gating on the row still
      // being completable means an overlapping complete-cron tick that already
      // transitioned some of them touches 0 of those (#163); `.select` returns
      // only the rows this UPDATE actually changed.
      const { data } = await supabaseAdmin()
        .from("bookings")
        .update({ status: "completed" })
        .in("id", bookingIds)
        .in("status", ["confirmed", "rescheduled"])
        .select("id");
      return ((data ?? []) as { id: string }[]).map((r) => r.id);
    },

    claimReschedule: async (bookingId, targetStartIso) => {
      const db = supabaseAdmin();
      // Best-effort reclaim of a lock orphaned by a torn-down Worker.
      const staleBefore = new Date(
        Date.now() - RESCHEDULE_LOCK_TTL_MS,
      ).toISOString();
      await db
        .from("reschedule_locks")
        .delete()
        .eq("booking_id", bookingId)
        .lt("claimed_at", staleBefore);
      // The composite-PK insert is the atomic arbiter: one concurrent caller
      // wins, a duplicate hits a unique violation (23505) and loses.
      const { error } = await db
        .from("reschedule_locks")
        .insert({ booking_id: bookingId, target_starts_at: targetStartIso });
      if (!error) return true;
      if (error.code === "23505") return false;
      // An unexpected lock error must not block a legitimate reschedule.
      console.error(
        `reschedule lock claim failed for booking ${bookingId}: ${error.message}`,
      );
      return true;
    },

    releaseReschedule: async (bookingId, targetStartIso) => {
      await supabaseAdmin()
        .from("reschedule_locks")
        .delete()
        .eq("booking_id", bookingId)
        .eq("target_starts_at", targetStartIso);
    },

    loadBookingContext: async (token) => {
      const db = supabaseAdmin();
      const { data: booking } = await db
        .from("bookings")
        .select("*")
        .eq("manage_token", token)
        .maybeSingle();
      if (!booking) return null;

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
    },

    loadBookingById: async (bookingId) => {
      const db = supabaseAdmin();
      const { data: booking } = await db
        .from("bookings")
        .select("*")
        .eq("id", bookingId)
        .maybeSingle();
      if (!booking) return null;

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
    },

    getAgentByEmail: async (email) => {
      const { data } = await supabaseAdmin()
        .from("users")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      return (data as User | null) ?? null;
    },

    loadPastBookingsToComplete: async () => {
      const db = supabaseAdmin();
      const nowIso = new Date().toISOString();
      const { data: rows } = await db
        .from("bookings")
        .select("*")
        .in("status", ["confirmed", "rescheduled"])
        .lt("ends_at", nowIso)
        .limit(200);

      const bookings = (rows ?? []) as Booking[];
      if (bookings.length === 0) return [];

      // Resolve buckets + event types with two `.in()` queries and join in
      // memory, instead of two lookups per booking (~400 round-trips) (#164).
      const bucketIds = [...new Set(bookings.map((b) => b.bucket_id))];
      const eventTypeIds = [...new Set(bookings.map((b) => b.event_type_id))];
      const [{ data: buckets }, { data: eventTypes }] = await Promise.all([
        db.from("buckets").select("*").in("id", bucketIds),
        db.from("event_types").select("*").in("id", eventTypeIds),
      ]);

      return joinBookingContexts(
        bookings,
        (buckets ?? []) as Bucket[],
        (eventTypes ?? []) as EventType[],
      );
    },
  };
}

export function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  return orchestration.createBooking(input, realDeps());
}

export function rescheduleBooking(
  token: string,
  newStartIso: string,
): Promise<BookingResult> {
  return orchestration.rescheduleBooking(token, newStartIso, realDeps());
}

export function cancelBooking(token: string): Promise<void> {
  return orchestration.cancelBooking(token, realDeps());
}

export function reassignBooking(
  bookingId: string,
  agentEmail: string,
): Promise<BookingResult> {
  return orchestration.reassignBooking(bookingId, agentEmail, realDeps());
}

export function completePastBookings(): Promise<number> {
  return orchestration.completePastBookings(realDeps());
}

export function getBookingByToken(token: string): Promise<BookingContext | null> {
  return orchestration.getBookingByToken(token, realDeps());
}
