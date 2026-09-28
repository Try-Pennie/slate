import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { namedAgentTimesLiveDeps } from "@/lib/agent-link/service";
import {
  bookingRescheduleTimes,
  type RescheduleTimesBooking,
  type RescheduleTimesReply,
} from "@/lib/booking/reschedule-times";
import type { BookingKind } from "@/lib/db/types";
import { log } from "@/lib/log";

/**
 * The real wiring for an advisor link booking's move times (#2827). The decisions
 * are in `reschedule-times.ts`, which the node suite drives through fakes.
 *
 * Two keys reach it, and each is scoped by what it is: the lead's MANAGE TOKEN on
 * the public `/api/availability?booking=`, and a BOOKING ID inside the caller's
 * own org on the staff route. Neither names an advisor.
 */
type Key = { manageToken: string } | { bookingId: string; orgId: string };

interface Row {
  status: string;
  kind: BookingKind;
  assigned_user_id: string | null;
  buckets: { code: string } | null;
}

async function loadBooking(key: Key): Promise<RescheduleTimesBooking | null> {
  let q = supabaseAdmin().from("bookings").select("status, kind, assigned_user_id, buckets!inner(code)");
  q = "manageToken" in key ? q.eq("manage_token", key.manageToken) : q.eq("id", key.bookingId).eq("org_id", key.orgId);
  // Throws on a failed read, so the route answers 500 rather than the refusal,
  // which a lead would read as final (#277).
  const row = unwrap(await q.maybeSingle(), "reschedule times booking") as Row | null;
  if (!row || !row.buckets) return null;
  return {
    status: row.status,
    kind: row.kind,
    assignedUserId: row.assigned_user_id,
    bucketCode: row.buckets.code,
  };
}

export function bookingRescheduleTimesLive(
  key: Key,
  query: { from: string | null; to: string | null },
  nowMs: number,
): Promise<RescheduleTimesReply> {
  return bookingRescheduleTimes(key, query, nowMs, {
    ...namedAgentTimesLiveDeps("reschedule-times"),
    loadBooking,
    // The cause, never the key: a manage token in the log is a working link in the log.
    logRefusal: (why) => log.info("reschedule-times", { msg: "no advisor times to offer", why }),
  });
}
