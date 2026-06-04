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
import type { Booking, Bucket, EventType, User } from "@/lib/db/types";
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
    isFree,
    createEvent,
    deleteEvent,
    updateEventTime,
    emitWebhook,
    appBaseUrl: appUrl,
    newManageToken: () => nanoid(24),

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

    insertBusyBlock: async (block) => {
      await supabaseAdmin().from("busy_blocks").insert(block);
    },

    deleteBusyBlocksForBooking: async (bookingId) => {
      await supabaseAdmin()
        .from("busy_blocks")
        .delete()
        .eq("booking_id", bookingId);
    },

    updateBooking: async (bookingId, patch) => {
      await supabaseAdmin().from("bookings").update(patch).eq("id", bookingId);
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

    loadPastBookingsToComplete: async () => {
      const db = supabaseAdmin();
      const nowIso = new Date().toISOString();
      const { data: rows } = await db
        .from("bookings")
        .select("*")
        .in("status", ["confirmed", "rescheduled"])
        .lt("ends_at", nowIso)
        .limit(200);

      const out: BookingContext[] = [];
      for (const row of (rows ?? []) as Booking[]) {
        const [{ data: bucket }, { data: eventType }] = await Promise.all([
          db.from("buckets").select("*").eq("id", row.bucket_id).single(),
          db.from("event_types").select("*").eq("id", row.event_type_id).single(),
        ]);
        out.push({
          booking: row,
          bucket: bucket as Bucket,
          eventType: eventType as EventType,
        });
      }
      return out;
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

export function completePastBookings(): Promise<number> {
  return orchestration.completePastBookings(realDeps());
}

export function getBookingByToken(token: string): Promise<BookingContext | null> {
  return orchestration.getBookingByToken(token, realDeps());
}
