import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import {
  resolveBucketByCode,
  roundRobinCandidates,
} from "@/lib/availability/service";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import { bucketsForAgent } from "@/lib/availability/precompute";
import {
  createEvent,
  deleteEvent,
  freeBusy,
  freeBusyMany,
  isFree,
  updateEventTime,
} from "@/lib/google/calendar";
import {
  joinBookingContexts,
  calendarIdsFromResult,
  freeAgentsFromBusy,
  type CalendarBusy,
  type ValidatedReason,
  type BookingActor,
} from "@/lib/booking/core";
import type { ReassignAgent } from "@/lib/booking/reassign-agents";
import { mapWithConcurrency } from "@/lib/concurrency";
import * as orchestration from "@/lib/booking/orchestration";
import type {
  ApiBookingInput,
  ApiBookingResult,
  ApiBookingPreview,
  BookingContext,
  BookingDeps,
  BookingResult,
  CreateBookingInput,
  ReschedulePin,
} from "@/lib/booking/orchestration";
import { toE164 } from "@/lib/phone";
import { escapeLike } from "@/lib/sql-like";
import { noEligibleAgentsAlert } from "@/lib/availability/bucket-coverage";
import { emitWebhook } from "@/lib/webhooks/emit";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type {
  Booking,
  BookingEventInitiator,
  BookingStatus,
  BookingOutbox,
  BookingReservation,
  Bucket,
  EventType,
  User,
} from "@/lib/db/types";
import { processBookingOutbox } from "@/lib/booking/outbox";
import { drainBackoffMs, DRAIN_GIVE_UP_AT, DRAIN_ALERT_AFTER } from "@/lib/booking/drain-backoff";

const CACHE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// A reschedule finishes in seconds; this TTL only governs reclaiming a lock
// orphaned by a torn-down Worker, so keep it comfortably above the slowest run.
const RESCHEDULE_LOCK_TTL_MS = 2 * 60 * 1000;
// Extra buffer past lease expiry before the GC sweep treats a pin as abandoned
// (#439) — well clear of any in-flight retry that's about to take over the lease.
const ABANDONED_PIN_GRACE_MS = 2 * 60 * 1000;
// Lease held while a drain processes one outbox row; only governs reclaiming a
// row orphaned by a torn-down Worker, so keep it above the slowest single-row run.
const OUTBOX_LEASE_TTL_MS = 2 * 60 * 1000;
const OUTBOX_DRAIN_LIMIT = 50;
// Reservation lease + drain bounds (#429 P4). Crash-during-create is rare, so a
// small cap with a multi-tick backlog is fine; bounds Worker CPU. Retention
// deletes abandoned pending reservations older than the TTL.
const RESERVATION_LEASE_TTL_MS = 2 * 60 * 1000;
const RESERVATION_DRAIN_LIMIT = 15;
const RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;
// Throttle the "drain rows are stuck" Slack alert (#445) so a persistently-
// failing row alerts at most twice an hour, not every tick.
const DRAIN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const VERIFY_READ_ALERT_KEY = "verify_on_book_calendars_read";
const VERIFY_READ_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// Fires when a booking/reschedule FAILS because no candidate could be verified
// (a likely verify-on-book outage), as opposed to a genuinely full slot (#319).
const VERIFY_OUTAGE_ALERT_KEY = "verify_on_book_outage";
const VERIFY_OUTAGE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// Fires when a live booking hits a bucket with NO eligible agents — the reactive
// half of the routing dead-zone monitor (#327); the proactive hourly sweep is in
// availability/service.ts.
const NO_ELIGIBLE_AGENTS_ALERT_KEY = "no_eligible_agents";
const NO_ELIGIBLE_AGENTS_COOLDOWN_MS = 60 * 60 * 1000;

// Google caps a freeBusy query at 20 calendar `items` (verified live against the
// production domain — 20 → 0 errors, 21 → tooManyCalendarsRequested), so the
// bulk verifier chunks calendar ids at 20 per call.
const FREEBUSY_MAX_ITEMS = 20;
// Max simultaneous freeBusy calls (Cloudflare's simultaneous-connection ceiling,
// same bound the completion-sweep webhook fan-out uses).
const VERIFY_CONCURRENCY = 6;

/**
 * Calendar ids whose busy blocks an agent, looked up by their email (#314).
 * Reports `readFailed` so verify-on-book can tell a real DB error apart from a
 * genuine empty: on an error we must NOT silently fall back to checking only the
 * primary calendar (it could miss a conflict on a secondary one and double-book).
 */
async function calendarIdsForEmail(
  email: string,
): Promise<{ readFailed: boolean; ids: string[] }> {
  const db = supabaseAdmin();
  const userRes = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (userRes.error) return { readFailed: true, ids: [] };
  if (!userRes.data) return { readFailed: false, ids: [] };
  const calsRes = await db
    .from("agent_calendars")
    .select("calendar_id")
    .eq("user_id", (userRes.data as { id: string }).id);
  return calendarIdsFromResult(calsRes);
}

/**
 * Batched cousin of `calendarIdsForEmail` for the verify-on-book wave: resolves
 * EVERY candidate's concrete calendar ids in two `.in()` queries (one users, one
 * agent_calendars) instead of two per agent. Returns each email's calendar ids
 * (their primary calendar id IS their email; secondaries come from
 * agent_calendars), plus the set of emails whose read FAILED — those route to the
 * accurate per-agent fallback rather than being assumed free (#314). A query
 * error fails the whole wave's reads (the caller falls back per agent).
 *
 * Note: the bulk freeBusy is read as ONE identity, so calendar ids must be
 * CONCRETE (the agent's email / real calendar id) — never the literal "primary",
 * which would resolve to the impersonator's own calendar.
 */
async function calendarsForEmails(
  emails: string[],
): Promise<{ byEmail: Map<string, string[]>; readFailed: Set<string> }> {
  const byEmail = new Map<string, string[]>();
  const readFailed = new Set<string>();
  if (emails.length === 0) return { byEmail, readFailed };

  const db = supabaseAdmin();
  const usersRes = await db
    .from("users")
    .select("id, email")
    .in("email", emails);
  if (usersRes.error) {
    // Can't map any agent to their calendars — fall back per agent for all.
    for (const e of emails) readFailed.add(e);
    return { byEmail, readFailed };
  }
  const userRows = (usersRes.data ?? []) as { id: string; email: string }[];
  const idByEmail = new Map(userRows.map((r) => [r.email, r.id]));

  const calsRes = await db
    .from("agent_calendars")
    .select("user_id, calendar_id")
    .in(
      "user_id",
      userRows.map((r) => r.id),
    );
  if (calsRes.error) {
    for (const e of emails) readFailed.add(e);
    return { byEmail, readFailed };
  }
  const calsByUser = new Map<string, string[]>();
  for (const row of (calsRes.data ?? []) as {
    user_id: string;
    calendar_id: string;
  }[]) {
    const list = calsByUser.get(row.user_id) ?? [];
    list.push(row.calendar_id);
    calsByUser.set(row.user_id, list);
  }

  for (const email of emails) {
    const userId = idByEmail.get(email);
    const cals = userId ? calsByUser.get(userId) : undefined;
    // Clean empty (pre-first-sync) or unknown user → the email IS the primary
    // calendar id, which the bulk query can read cross-identity.
    byEmail.set(email, cals && cals.length ? cals : [email]);
  }
  return { byEmail, readFailed };
}

/** Outcome of a single-agent verify: confirmed free, confirmed busy, or — when a
 *  calendar couldn't be read — unverifiable (#319). `unverified` is never treated
 *  as free (no double-book) and lets the caller flag a likely outage. */
type AgentVerdict = "free" | "busy" | "unverified";

/**
 * Direct per-agent verify (impersonates the agent, checks all their calendars) —
 * the accurate fallback for the bulk verifier when a calendar couldn't be read in
 * the cross-identity batch (#314) or the bulk call failed wholesale. A
 * calendar-read failure yields `unverified` (skip + alert) instead of being
 * conflated with `busy`, so a verify-on-book outage is distinguishable from a
 * genuinely full slot (#319).
 */
async function checkAgentFree(
  email: string,
  startIso: string,
  endIso: string,
  ignore?: { start: string; end: string },
): Promise<AgentVerdict> {
  const { readFailed, ids } = await calendarIdsForEmail(email);
  if (readFailed) {
    await sendThrottledAlert(
      VERIFY_READ_ALERT_KEY,
      VERIFY_READ_ALERT_COOLDOWN_MS,
      `Slate: verify-on-book could not read calendars for ${email}; skipping this agent for the slot to avoid a double-book. Check DB health.`,
    ).catch(() => {});
    return "unverified";
  }
  return (await isFree(email, startIso, endIso, ids.length ? ids : ["primary"], ignore))
    ? "free"
    : "busy";
}

/**
 * Live busy intervals (epoch-ms) across ALL of one agent's calendars over the
 * window — the in-place reschedule guard's read (#536). Resolves the agent's
 * calendars the same way the per-agent verify does; on a calendar-read failure it
 * alerts and returns `null` so the guard re-routes rather than risk keeping an
 * agent on an unverifiable slot (the same SAFE default the old `isFree` path had).
 */
async function agentBusyIntervals(
  email: string,
  fromIso: string,
  toIso: string,
): Promise<{ start: number; end: number }[] | null> {
  const { readFailed, ids } = await calendarIdsForEmail(email);
  if (readFailed) {
    await sendThrottledAlert(
      VERIFY_READ_ALERT_KEY,
      VERIFY_READ_ALERT_COOLDOWN_MS,
      `Slate: in-place reschedule could not read calendars for ${email}; re-routing to avoid keeping the agent on an unverifiable slot. Check DB health.`,
    ).catch(() => {});
    return null;
  }
  const busy = await freeBusy(email, fromIso, toIso, ids.length ? ids : ["primary"]);
  return busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

export {
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  DailyCapExceededError,
  UnknownBucketError,
  BookingNotFoundError,
  BookingNotCancellableError,
  AgentNotAvailableError,
  BookingNotChangeableError,
} from "@/lib/booking/orchestration";
export type { BookingResult, CreateBookingInput };
export type { BookingActor } from "@/lib/booking/core";

/**
 * Binds the booking orchestration to real IO. This is the ONLY place the
 * booking flow touches Supabase, Google Calendar, or webhooks; the logic lives
 * in `orchestration.ts` and is exercised by `scripts/test-booking-orchestration.ts`.
 */
function realDeps(): BookingDeps {
  return {
    resolveBucketByCode,
    roundRobinCandidates,
    // Live busy intervals for the in-place reschedule guard (#536): checks ALL the
    // agent's calendars; a read failure returns null -> the guard re-routes. The
    // guard runs the SAME isBookableSlotForAgent predicate the booker does, so a
    // reschedule can't keep an agent on a slot the booker would never offer.
    busyIntervalsForAgent: agentBusyIntervals,
    // The agent's OTHER active bookings in a window (#536), epoch-ms, excluding the
    // booking being moved — the in-place guard counts these for the daily cap.
    agentActiveBookingStartsMs: async (userId, fromIso, toIso, excludeBookingId) => {
      const { data } = await supabaseAdmin()
        .from("bookings")
        .select("starts_at")
        .eq("assigned_user_id", userId)
        .in("status", ["confirmed", "rescheduled"])
        .gte("starts_at", fromIso)
        .lt("starts_at", toIso)
        .neq("id", excludeBookingId);
      return ((data as { starts_at: string }[] | null) ?? []).map((r) => Date.parse(r.starts_at));
    },
    // Working-hours schedule for one agent (#527), used by the in-place reschedule
    // guard. Mirrors loadMembersAvailability's nested select. A schedule-less agent
    // — or a transient read error — falls back to America/New_York + no rules, so
    // the guard treats them as off-shift and re-routes (the SAFE default here: it
    // sends the booking through the schedule-aware reassign path, never keeps an
    // off-shift agent). Consistent with assembleMemberAvailability's default.
    agentWorkingHours: async (userId) => {
      const fallback = { timezone: "America/New_York", rules: [] };
      const { data } = await supabaseAdmin()
        .from("availability_schedules")
        .select("timezone, availability_rules(weekday, start_minute, end_minute)")
        .eq("user_id", userId)
        .limit(1);
      const row = (
        data as unknown as
          | {
              timezone: string;
              availability_rules: { weekday: number; start_minute: number; end_minute: number }[];
            }[]
          | null
      )?.[0];
      if (!row) return fallback;
      return {
        timezone: row.timezone,
        rules: (row.availability_rules ?? []).map((r) => ({
          weekday: r.weekday,
          start_minute: r.start_minute,
          end_minute: r.end_minute,
        })),
      };
    },
    // Batched verify-on-book (#167): read the whole candidate wave's free/busy
    // in ONE cross-identity freeBusy call (chunked at Google's 20-calendar cap,
    // chunks fired with bounded concurrency) instead of one serial Google call
    // per candidate. An agent is free only if EVERY one of their calendars read
    // cleanly and none overlaps; any unread/errored calendar — or a wholesale
    // bulk failure — routes that agent to the accurate direct per-agent check,
    // so accuracy is never traded for speed.
    verifyFree: async (emails, startIso, endIso) => {
      const free = new Set<string>();
      const unverified = new Set<string>();
      if (emails.length === 0) return { free, unverified };

      const { byEmail, readFailed } = await calendarsForEmails(emails);
      const bulkAgents = emails
        .filter((e) => !readFailed.has(e))
        .map((e) => ({ email: e, calendarIds: byEmail.get(e) ?? [e] }));
      const fallback = new Set<string>(readFailed);

      if (bulkAgents.length > 0) {
        try {
          // Read as one candidate's identity — domain free/busy is cross-visible.
          const subject = bulkAgents[0].email;
          const allCalIds = [
            ...new Set(bulkAgents.flatMap((a) => a.calendarIds)),
          ];
          const chunks: string[][] = [];
          for (let i = 0; i < allCalIds.length; i += FREEBUSY_MAX_ITEMS) {
            chunks.push(allCalIds.slice(i, i + FREEBUSY_MAX_ITEMS));
          }
          const maps = await mapWithConcurrency(
            chunks,
            VERIFY_CONCURRENCY,
            (chunk) => freeBusyMany(subject, startIso, endIso, chunk),
          );
          const busyByCalendar = new Map<string, CalendarBusy>();
          for (const m of maps) for (const [k, v] of m) busyByCalendar.set(k, v);

          const res = freeAgentsFromBusy(
            bulkAgents,
            busyByCalendar,
            Date.parse(startIso),
            Date.parse(endIso),
          );
          for (const e of res.free) free.add(e);
          for (const e of res.needsFallback) fallback.add(e);
        } catch (err) {
          // Total bulk failure (e.g. the subject's delegated token couldn't be
          // minted) — verify everyone directly per agent rather than fail.
          console.error(
            "verify-on-book bulk freeBusy failed; falling back to per-agent:",
            err instanceof Error ? err.message : err,
          );
          for (const a of bulkAgents) fallback.add(a.email);
        }
      }

      if (fallback.size > 0) {
        const list = [...fallback];
        const verdicts = await mapWithConcurrency(
          list,
          VERIFY_CONCURRENCY,
          (email) => checkAgentFree(email, startIso, endIso),
        );
        list.forEach((email, i) => {
          if (verdicts[i] === "free") free.add(email);
          else if (verdicts[i] === "unverified") unverified.add(email);
        });
      }

      return { free, unverified };
    },
    createEvent,
    deleteEvent,
    enqueueEventDeletion: async (calendarEmail, gcalEventId, bookingId) => {
      await supabaseAdmin()
        .from("pending_event_deletions")
        .upsert(
          { calendar_email: calendarEmail, gcal_event_id: gcalEventId, booking_id: bookingId },
          { onConflict: "calendar_email,gcal_event_id", ignoreDuplicates: true },
        );
    },
    loadPendingEventDeletions: async (limit) => {
      const { data } = await supabaseAdmin()
        .from("pending_event_deletions")
        .select("*")
        .lt("attempts", orchestration.PENDING_DELETION_GIVE_UP_AT)
        .order("attempts", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as orchestration.PendingEventDeletion[];
    },
    removePendingEventDeletion: async (id) => {
      await supabaseAdmin().from("pending_event_deletions").delete().eq("id", id);
    },
    bumpPendingEventDeletion: async (id, attempts, error) => {
      await supabaseAdmin()
        .from("pending_event_deletions")
        .update({ attempts, last_error: error })
        .eq("id", id);
    },
    updateEventTime,
    emitWebhook,
    appBaseUrl: appUrl,
    newManageToken: () => nanoid(24),
    // Keyless (anonymous) bookings synthesize a unique key so they still get the
    // reservation-backed crash-safe create (#666). "anon_" prefix + nanoid can
    // never contain a "|", so it can't collide with a derived contact key.
    newIdempotencyKey: () => `anon_${nanoid(24)}`,
    // A booking changed the bucket's availability: recompute its precomputed
    // row so the booked slot disappears. Fire-and-forget so the confirm isn't
    // blocked on the recompute; the recompute lane's freshness sweep is the
    // backstop if this best-effort call is missed.
    invalidateSlots: (bucketCode) => {
      void recomputeBucketSlotsForToday(bucketCode).catch(() => {});
      return Promise.resolve();
    },

    getUser: async (userId) => {
      const { data } = await supabaseAdmin()
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();
      return data as User;
    },

    loadEmails: async (userIds) => {
      const m = new Map<string, string>();
      if (userIds.length === 0) return m;
      const { data } = await supabaseAdmin()
        .from("users")
        .select("id, email")
        .in("id", userIds);
      for (const row of (data ?? []) as { id: string; email: string | null }[]) {
        if (row.email) m.set(row.id, row.email);
      }
      return m;
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

    moveBusyBlock: async (userId, startIso, endIso, bookingId) => {
      // Atomic delete-by-booking + insert in one SQL function (#429 P3). Same
      // write-through posture as insert/delete: a failure must not fail the
      // booking change (the move already happened) — log + throttled alert.
      const { error } = await supabaseAdmin().rpc("move_busy_block", {
        p_booking_id: bookingId,
        p_user_id: userId,
        p_starts_at: startIso,
        p_ends_at: endIso,
      });
      if (error) {
        console.error(
          `busy_blocks move failed for booking ${bookingId}: ${error.message}`,
        );
        await sendThrottledAlert(
          "busy_block_write_through",
          CACHE_ALERT_COOLDOWN_MS,
          `Slate: busy_blocks move (move_busy_block) failed for booking ${bookingId} (${error.message}). The slot cache may be stale until the next sync pass.`,
        ).catch(() => {});
      }
    },

    reassignSwap: async ({ bookingId, userId, agentName, agentEmail, gcalEventId, routingTrace }) => {
      // Atomic swap-and-return-previous (#449). Unlike the best-effort cache
      // writes, this IS the durable anchor of the reassign, so a failure must
      // surface (the caller cleans up the event it created and reports failure).
      // The reassignment audit record is appended server-side under the row lock
      // (#519) so concurrent reassigns accumulate full history; p_routing_trace
      // only seeds the row's trace when it has none yet.
      const { data, error } = await supabaseAdmin().rpc("reassign_booking_swap", {
        p_booking_id: bookingId,
        p_user_id: userId,
        p_agent_name: agentName,
        p_agent_email: agentEmail,
        p_gcal_event_id: gcalEventId,
        p_routing_trace: routingTrace,
      });
      if (error) {
        throw new Error(`reassign_booking_swap failed for booking ${bookingId}: ${error.message}`);
      }
      const row = ((data ?? []) as {
        prev_gcal_event_id: string | null;
        prev_agent_email: string | null;
        updated: boolean;
      }[])[0];
      return {
        prevGcalEventId: row?.prev_gcal_event_id ?? null,
        prevAgentEmail: row?.prev_agent_email ?? null,
        updated: row?.updated ?? false,
      };
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

    deleteGcalMirrorBlock: async (userId, gcalEventId) => {
      // #586: clear a stray source=gcal mirror of a Slate booking's own event. Scoped
      // to source=gcal + this exact gcal_event_id, so it can never touch the booking's
      // source=slate write-through block (which carries a null gcal_event_id). A single
      // retry on transient failure; a leftover mirror self-heals on the next full
      // resync (purgeVanished) and via the sync's slate-id delete, so no alert.
      const del = () =>
        supabaseAdmin()
          .from("busy_blocks")
          .delete()
          .eq("user_id", userId)
          .eq("source", "gcal")
          .eq("gcal_event_id", gcalEventId);
      let { error } = await del();
      if (error) ({ error } = await del());
      if (error) {
        console.error(
          `busy_blocks gcal-mirror delete failed for event ${gcalEventId}: ${error.message}`,
        );
      }
    },

    loadReconcilableBusyBlocks: async (limit) => {
      // Only upcoming slate rows: a past block can't block a bookable future
      // slot, and gcal mirrors are never freed by the reconcile sweep (#428).
      // Scoping to ends_at >= now keeps the scan bounded by concurrent future
      // bookings instead of the whole table.
      const { data, error } = await supabaseAdmin()
        .from("busy_blocks")
        .select("id, user_id, booking_id, source")
        .eq("source", "slate")
        .gte("ends_at", new Date().toISOString())
        .order("ends_at", { ascending: true })
        .limit(limit);
      if (error) {
        console.error(`reconcile: loadReconcilableBusyBlocks failed: ${error.message}`);
        return [];
      }
      return (data ?? []) as {
        id: string;
        user_id: string;
        booking_id: string | null;
        source: "slate" | "gcal";
      }[];
    },

    loadBookingStatuses: async (bookingIds) => {
      const map = new Map<string, BookingStatus>();
      if (bookingIds.length === 0) return map;
      const { data, error } = await supabaseAdmin()
        .from("bookings")
        .select("id, status")
        .in("id", bookingIds);
      if (error) {
        // Fail safe: an empty map would mark every booking "missing" and free
        // its slot. Throw so the sweep aborts this tick rather than over-delete.
        throw new Error(`reconcile: loadBookingStatuses failed: ${error.message}`);
      }
      for (const r of (data ?? []) as { id: string; status: BookingStatus }[]) {
        map.set(r.id, r.status);
      }
      return map;
    },

    deleteBusyBlocksByIds: async (ids) => {
      if (ids.length === 0) return;
      const { error } = await supabaseAdmin()
        .from("busy_blocks")
        .delete()
        .in("id", ids);
      if (error) {
        // Best-effort: the next tick re-finds and retries these rows.
        console.error(`reconcile: deleteBusyBlocksByIds failed: ${error.message}`);
      }
    },

    loadActiveUpcomingBookings: async (limit) => {
      // Active bookings whose slot is still in the future and that have an
      // assigned agent (a null-agent booking can't own a per-user busy_block).
      // Ordered created_at DESC: a missed write-through INSERT happens at create
      // time, so the freshest bookings are the likeliest to be missing a block -
      // scan those first within the `limit` cap.
      const { data, error } = await supabaseAdmin()
        .from("bookings")
        .select("id, assigned_user_id, starts_at, ends_at")
        .in("status", ["confirmed", "rescheduled"])
        .gte("ends_at", new Date().toISOString())
        .not("assigned_user_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        console.error(`reconcile-missing: loadActiveUpcomingBookings failed: ${error.message}`);
        return [];
      }
      return ((data ?? []) as {
        id: string;
        assigned_user_id: string;
        starts_at: string;
        ends_at: string;
      }[]).map((r) => ({
        id: r.id,
        user_id: r.assigned_user_id,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
      }));
    },

    loadBusyBlockBookingIds: async (bookingIds) => {
      if (bookingIds.length === 0) return new Set<string>();
      const { data, error } = await supabaseAdmin()
        .from("busy_blocks")
        .select("booking_id")
        .eq("source", "slate")
        .in("booking_id", bookingIds);
      if (error) {
        // Fail safe: an empty result would make EVERY booking look like it's
        // missing a block and trigger a re-insert for all of them. A duplicate
        // insert is benign (busy-over-free), but throwing aborts this tick so a
        // transient read blip can't mass-insert; the next tick retries.
        throw new Error(`reconcile-missing: loadBusyBlockBookingIds failed: ${error.message}`);
      }
      return new Set(
        ((data ?? []) as { booking_id: string | null }[])
          .map((r) => r.booking_id)
          .filter((id): id is string => !!id),
      );
    },

    // --- Outbox (#429 P2) ---
    enqueueOutbox: async (row) => {
      const { data } = await supabaseAdmin()
        .from("booking_outbox")
        .insert({
          booking_id: row.booking_id,
          action: row.action,
          steps: row.steps,
          payload: row.payload,
        })
        .select("id")
        .single();
      if (!data) throw new Error("enqueueOutbox: insert returned no row");
      return (data as { id: string }).id;
    },

    loadDrainableOutbox: async (limit) => {
      const nowIso = new Date().toISOString();
      // Drainable = pending, lease free/expired, retry time reached (#445:
      // next_attempt_at null/past), and under the give-up cap (a row past the cap
      // stays pending + diagnosable but is no longer retried).
      const { data, error } = await supabaseAdmin()
        .from("booking_outbox")
        .select("*")
        .eq("status", "pending")
        .lt("attempts", DRAIN_GIVE_UP_AT)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        console.error(`outbox: loadDrainableOutbox failed: ${error.message}`);
        return [];
      }
      return (data ?? []) as BookingOutbox[];
    },

    leaseOutbox: async (id) => {
      // Atomic claim: the WHERE gates on the lease being free/expired, so two
      // concurrent drains can't both take it (the loser updates 0 rows).
      const now = Date.now();
      const { data } = await supabaseAdmin()
        .from("booking_outbox")
        .update({ lease_until: new Date(now + OUTBOX_LEASE_TTL_MS).toISOString() })
        .eq("id", id)
        .or(`lease_until.is.null,lease_until.lt.${new Date(now).toISOString()}`)
        .select("id");
      return ((data ?? []) as unknown[]).length > 0;
    },

    saveOutboxSteps: async (id, steps) => {
      await supabaseAdmin()
        .from("booking_outbox")
        .update({ steps, updated_at: new Date().toISOString() })
        .eq("id", id);
    },

    markOutboxDelivered: async (id) => {
      await supabaseAdmin()
        .from("booking_outbox")
        .update({
          status: "delivered",
          lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    },

    releaseOutboxLease: async (id) => {
      await supabaseAdmin()
        .from("booking_outbox")
        .update({ lease_until: null })
        .eq("id", id);
    },

    bumpOutboxAttempt: async (id, attempts, lastError) => {
      await supabaseAdmin()
        .from("booking_outbox")
        .update({
          attempts,
          last_error: lastError,
          next_attempt_at: new Date(Date.now() + drainBackoffMs(attempts)).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    },

    // --- Create reservations (#429 P4) ---
    insertReservation: async (row) => {
      const db = supabaseAdmin();
      const { data, error } = await db
        .from("booking_reservations")
        .insert(row)
        .select("*")
        .single();
      if (!error && data) return data as BookingReservation;
      // UNIQUE(idempotency_key) violation: another create won the race. Its row
      // is committed (the unique check waits on the in-flight insert), so load +
      // adopt it — both creates converge on ONE pinned agent + client id.
      const { data: winner } = await db
        .from("booking_reservations")
        .select("*")
        .eq("idempotency_key", row.idempotency_key)
        .single();
      if (winner) return winner as BookingReservation;
      throw new Error(`insertReservation failed: ${error?.message ?? "no row returned"}`);
    },

    loadReservationByKey: async (idempotencyKey) => {
      const { data } = await supabaseAdmin()
        .from("booking_reservations")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      return data ? (data as BookingReservation) : null;
    },

    deleteReservation: async (id) => {
      await supabaseAdmin().from("booking_reservations").delete().eq("id", id);
    },

    loadDrainableReservations: async (limit) => {
      const nowIso = new Date().toISOString();
      // Same drainability gate as the outbox (#445): pending, lease free, retry
      // time reached, under the give-up cap.
      const { data, error } = await supabaseAdmin()
        .from("booking_reservations")
        .select("*")
        .eq("status", "pending")
        .lt("attempts", DRAIN_GIVE_UP_AT)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        console.error(`reservations: loadDrainable failed: ${error.message}`);
        return [];
      }
      return (data ?? []) as BookingReservation[];
    },

    leaseReservation: async (id) => {
      const now = Date.now();
      const { data } = await supabaseAdmin()
        .from("booking_reservations")
        .update({ lease_until: new Date(now + RESERVATION_LEASE_TTL_MS).toISOString() })
        .eq("id", id)
        .or(`lease_until.is.null,lease_until.lt.${new Date(now).toISOString()}`)
        .select("id");
      return ((data ?? []) as unknown[]).length > 0;
    },

    releaseReservationLease: async (id) => {
      await supabaseAdmin()
        .from("booking_reservations")
        .update({ lease_until: null })
        .eq("id", id);
    },

    bumpReservationAttempt: async (id, attempts, lastError) => {
      await supabaseAdmin()
        .from("booking_reservations")
        .update({
          attempts,
          last_error: lastError,
          next_attempt_at: new Date(Date.now() + drainBackoffMs(attempts)).toISOString(),
        })
        .eq("id", id);
    },

    deleteExpiredReservations: async (olderThanIso, limit) => {
      const db = supabaseAdmin();
      const { data } = await db
        .from("booking_reservations")
        .select("id")
        .eq("status", "pending")
        .lt("created_at", olderThanIso)
        .limit(limit);
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
      if (ids.length) await db.from("booking_reservations").delete().in("id", ids);
    },

    commitReschedule: async (bookingId, patch, guard) => {
      // Gated commit (#615): apply the move only while the booking is still
      // active AND its assignee + event id are unchanged since we read them.
      // A concurrent cancel (status flip) or reassign (assignee + event id swap)
      // makes this touch 0 rows; `.select` returns a row only when THIS UPDATE
      // transitioned it. Same shape as claimCancellation / completeBookingsIfDue.
      const base = supabaseAdmin()
        .from("bookings")
        .update(patch)
        .eq("id", bookingId)
        .in("status", ["confirmed", "rescheduled"]);
      const withAssignee =
        guard.assignedUserId === null
          ? base.is("assigned_user_id", null)
          : base.eq("assigned_user_id", guard.assignedUserId);
      const gated =
        guard.gcalEventId === null
          ? withAssignee.is("gcal_event_id", null)
          : withAssignee.eq("gcal_event_id", guard.gcalEventId);
      const { data } = await gated.select("id");
      return ((data ?? []) as { id: string }[]).length > 0;
    },

    claimCancellation: async (bookingId) => {
      // Atomic flip active->cancelled (#413). Gating on the row still being in an
      // active status (not just "not cancelled") means a concurrent cancel OR a
      // complete-cron tick that already terminated it touches 0 rows (#618); a
      // completed booking can never regress to cancelled. `.select` returns the
      // row only when THIS call made the transition.
      const { data } = await supabaseAdmin()
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("id", bookingId)
        .in("status", ["confirmed", "rescheduled"])
        .select("id");
      return ((data ?? []) as { id: string }[]).length > 0;
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

    // Per-booking reschedule lease (#439, migration 0053). The booking_id PK is
    // the atomic arbiter: at most one in-flight reschedule per booking. The
    // discriminated outcome distinguishes a fresh win, a crash-resume (expired
    // lease + a written pin), a different-target abandon, a same-target no-op, and
    // a different-target conflict. Fails CLOSED on an unexpected DB error (user
    // escalation decision): throws a retriable error rather than proceeding, so a
    // claim we can't trust never re-opens the concurrent-duplicate window.
    claimReschedule: async (bookingId, targetStartIso) => {
      const db = supabaseAdmin();
      const now = Date.now();
      const leaseUntil = new Date(now + RESCHEDULE_LOCK_TTL_MS).toISOString();
      const { error } = await db.from("reschedule_locks").insert({
        booking_id: bookingId,
        target_starts_at: targetStartIso,
        claimed_at: new Date(now).toISOString(),
        lease_until: leaseUntil,
      });
      if (!error) return { outcome: "won" };
      if (error.code !== "23505") {
        // Fail CLOSED on an unexpected DB error (user escalation decision): block
        // with a retriable error rather than proceed, so a claim we can't trust
        // never re-opens the concurrent-duplicate window. No lock is held yet (the
        // claim is before the wrapper's try/finally), so nothing to release.
        console.error(`reschedule lock claim failed for booking ${bookingId}: ${error.message}`);
        throw new Error("Could not lock this booking for reschedule. Please try again.");
      }
      // A lease already exists — load it (+ the booking) to decide.
      const { data: lock } = await db
        .from("reschedule_locks")
        .select(
          "target_starts_at, lease_until, pinned_user_id, pinned_agent_email, gcal_client_id, branch, reschedule_seq",
        )
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (!lock) return { outcome: "won" }; // released between insert + read; retry as fresh
      const { data: bk } = await db
        .from("bookings")
        .select("starts_at")
        .eq("id", bookingId)
        .maybeSingle();
      if (bk && Date.parse(bk.starts_at) === Date.parse(targetStartIso)) {
        return { outcome: "idempotent" }; // already at target (a holder committed)
      }
      const expired = !lock.lease_until || Date.parse(lock.lease_until) <= now;
      const sameTarget = Date.parse(lock.target_starts_at) === Date.parse(targetStartIso);
      if (!expired) {
        return sameTarget ? { outcome: "idempotent" } : { outcome: "conflict" };
      }
      // Expired lease = a crashed holder. Take it over (re-lease).
      await db
        .from("reschedule_locks")
        .update({ claimed_at: new Date(now).toISOString(), lease_until: leaseUntil })
        .eq("booking_id", bookingId);
      const hasPin =
        lock.gcal_client_id != null &&
        lock.pinned_user_id != null &&
        lock.pinned_agent_email != null &&
        lock.branch != null &&
        lock.reschedule_seq != null;
      if (!hasPin) return { outcome: "won" }; // crashed before any Google call -> fresh
      const pin: ReschedulePin = {
        reschedule_seq: lock.reschedule_seq!,
        branch: lock.branch as "in_place" | "reassign",
        pinned_user_id: lock.pinned_user_id!,
        pinned_agent_email: lock.pinned_agent_email!,
        gcal_client_id: lock.gcal_client_id!,
        target_starts_at: lock.target_starts_at,
      };
      return sameTarget ? { outcome: "resume", pin } : { outcome: "fresh-after-abandon", pin };
    },

    writeReschedulePin: async (bookingId, pin) => {
      await supabaseAdmin()
        .from("reschedule_locks")
        .update({
          pinned_user_id: pin.pinned_user_id,
          pinned_agent_email: pin.pinned_agent_email,
          gcal_client_id: pin.gcal_client_id,
          branch: pin.branch,
          reschedule_seq: pin.reschedule_seq,
          target_starts_at: pin.target_starts_at,
        })
        .eq("booking_id", bookingId);
    },

    readReschedulePin: async (bookingId) => {
      const { data } = await supabaseAdmin()
        .from("reschedule_locks")
        .select(
          "pinned_user_id, pinned_agent_email, gcal_client_id, branch, reschedule_seq, target_starts_at",
        )
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (
        !data ||
        data.gcal_client_id == null ||
        data.pinned_user_id == null ||
        data.pinned_agent_email == null ||
        data.branch == null ||
        data.reschedule_seq == null
      ) {
        return null;
      }
      return {
        reschedule_seq: data.reschedule_seq,
        branch: data.branch as "in_place" | "reassign",
        pinned_user_id: data.pinned_user_id,
        pinned_agent_email: data.pinned_agent_email,
        gcal_client_id: data.gcal_client_id,
        target_starts_at: data.target_starts_at,
      };
    },

    releaseReschedule: async (bookingId) => {
      await supabaseAdmin().from("reschedule_locks").delete().eq("booking_id", bookingId);
    },

    loadAbandonedReschedulePins: async (graceMs) => {
      const db = supabaseAdmin();
      const cutoff = new Date(Date.now() - graceMs).toISOString();
      const { data: rows } = await db
        .from("reschedule_locks")
        .select("booking_id, pinned_agent_email, gcal_client_id, branch")
        .lt("lease_until", cutoff)
        .not("gcal_client_id", "is", null);
      const locks = rows ?? [];
      if (locks.length === 0) return [];
      const ids = locks.map((r) => r.booking_id);
      const { data: bks } = await db.from("bookings").select("id, gcal_event_id").in("id", ids);
      const liveById = new Map((bks ?? []).map((b) => [b.id, b.gcal_event_id]));
      return locks.map((r) => ({
        booking_id: r.booking_id,
        pinned_agent_email: r.pinned_agent_email ?? "",
        gcal_client_id: r.gcal_client_id,
        branch: r.branch,
        booking_gcal_event_id: liveById.get(r.booking_id) ?? null,
      }));
    },

    // Append-only reschedule/cancel/reassign history (#326/#300). A failed
    // insert must NOT fail the booking change (the move already happened) — log
    // + throttled alert, like the busy_blocks write-through (#34). The reason is
    // analytics, not a safety guard, so losing it to a rare DB error is OK.
    insertBookingEvent: async (row) => {
      // Return the new row id for use as the webhook dedupe key (#436). A failed
      // insert returns null: the webhook then falls back to no-dedup so it still
      // fires (at-least-once) rather than being keyed to a missing row.
      const { data, error } = await supabaseAdmin()
        .from("booking_events")
        .insert(row)
        .select("id")
        .single();
      if (error) {
        console.error(
          `booking_events insert failed for booking ${row.booking_id} (${row.action}): ${error.message}`,
        );
        await sendThrottledAlert(
          "booking_event_insert",
          CACHE_ALERT_COOLDOWN_MS,
          `Slate: booking_events INSERT failed for booking ${row.booking_id} (${row.action}, ${error.message}). The reschedule/cancel reason for this action was not recorded.`,
        ).catch(() => {});
        return null;
      }
      return (data as { id: string }).id;
    },

    hasBookingEvent: async (bookingId, action, toStartsIso, rescheduleSeq) => {
      let q = supabaseAdmin()
        .from("booking_events")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("action", action);
      q = toStartsIso === null ? q.is("to_starts_at", null) : q.eq("to_starts_at", toStartsIso);
      if (rescheduleSeq != null) q = q.eq("reschedule_seq", rescheduleSeq);
      const { data } = await q.limit(1).maybeSingle();
      return data != null;
    },

    getBookingEventId: async (bookingId, action, toStartsIso, rescheduleSeq) => {
      let q = supabaseAdmin()
        .from("booking_events")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("action", action);
      q = toStartsIso === null ? q.is("to_starts_at", null) : q.eq("to_starts_at", toStartsIso);
      if (rescheduleSeq != null) q = q.eq("reschedule_seq", rescheduleSeq);
      const { data } = await q.limit(1).maybeSingle();
      return data ? (data as { id: string }).id : null;
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

    // #392 cross-person list: one parameterized, offset-paginated scan (every
    // filter via .eq/.gte/.lte/.gt, ordered + .range — never an interpolated
    // .or() string), plus a single .in() buckets join for each row's bucketCode.
    queryBookings: async (filter) => {
      let q = supabaseAdmin().from("bookings").select("*");
      if (filter.status) q = q.eq("status", filter.status);
      if (filter.afterStart) q = q.gte("starts_at", filter.afterStart);
      if (filter.beforeEnd) q = q.lte("starts_at", filter.beforeEnd);
      if (filter.updatedSince) q = q.gt("updated_at", filter.updatedSince);
      if (filter.bucketId) q = q.eq("bucket_id", filter.bucketId);
      if (filter.assignedUserId) q = q.eq("assigned_user_id", filter.assignedUserId);
      const { data } = await q
        .order(filter.orderBy, { ascending: true })
        .order("id", { ascending: true })
        .range(filter.offset, filter.offset + filter.limit - 1);
      const rows = (data ?? []) as Booking[];
      const bucketIds = [...new Set(rows.map((b) => b.bucket_id))];
      const buckets = bucketIds.length
        ? (((await supabaseAdmin().from("buckets").select("*").in("id", bucketIds)).data ?? []) as Bucket[])
        : [];
      return { rows, buckets };
    },

    findActiveBookingsForPerson: async (identity) => {
      const active = ["confirmed", "rescheduled"] as const;
      const base = () =>
        supabaseAdmin().from("bookings").select("*").in("status", active).limit(20);
      const queries: PromiseLike<{ data: unknown }>[] = [];
      if (identity.externalId)
        queries.push(base().eq("external_id", identity.externalId));
      if (identity.salesforceId)
        queries.push(base().eq("salesforce_id", identity.salesforceId));
      const email = identity.email?.trim();
      // Escape LIKE metacharacters (#620): an email's `_`/`%` must not act as an
      // ilike wildcard, or a `john_doe@` address would also fetch `johnXdoe@` and
      // an unordered limit(20) could crowd out the true row. Still case-insensitive
      // (matches the lowercased grader) and still served by the trigram index.
      if (email) queries.push(base().ilike("attendee_email", escapeLike(email)));
      const phone = toE164(identity.phone);
      if (phone) queries.push(base().eq("attendee_phone", phone));
      if (queries.length === 0) return [];

      const results = await Promise.all(queries);
      const byId = new Map<string, Booking>();
      for (const r of results)
        for (const row of (r.data ?? []) as Booking[]) byId.set(row.id, row);
      return [...byId.values()];
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

/**
 * Throttled alerting around a booking attempt, for the two failure modes that
 * are silent outages rather than ordinary "slot taken": verify-on-book couldn't
 * reach Google/DB for ANY candidate (#319), or the bucket has NO eligible agents
 * to route to (#327). Re-throws so the caller still maps the error to a response.
 * Best-effort: a failed alert never masks the original error.
 */
/**
 * Which throttled alert (if any) a booking failure warrants — pure so the
 * error→alert mapping is unit-tested without IO. Returns null for ordinary
 * failures (e.g. a genuinely taken slot) that aren't a silent outage.
 */
export function bookingFailureAlert(
  err: unknown,
): { key: string; cooldownMs: number; message: string } | null {
  if (err instanceof orchestration.VerifyUnavailableError) {
    return {
      key: VERIFY_OUTAGE_ALERT_KEY,
      cooldownMs: VERIFY_OUTAGE_ALERT_COOLDOWN_MS,
      message:
        "Slate: a booking failed because verify-on-book could not confirm ANY candidate's free/busy (likely a Google/DB outage), not because the slot was full. The lead saw a retryable error. Check Google Calendar API + DB health.",
    };
  }
  if (err instanceof orchestration.NoEligibleAgentsError) {
    return {
      // Per-bucket key so a second dead bucket isn't suppressed by the first's throttle.
      key: `${NO_ELIGIBLE_AGENTS_ALERT_KEY}:${err.bucketCode ?? "unknown"}`,
      cooldownMs: NO_ELIGIBLE_AGENTS_COOLDOWN_MS,
      message: noEligibleAgentsAlert(err.bucketCode),
    };
  }
  return null;
}

async function alertOnBookingFailure<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const spec = bookingFailureAlert(err);
    if (spec) {
      await sendThrottledAlert(spec.key, spec.cooldownMs, spec.message).catch(() => {});
    }
    throw err;
  }
}

/**
 * Decide the observability breadcrumb for a reschedule (#543). The pure booking
 * layer surfaces WHY the in-place agent was declined; this turns it into a log
 * line. A routine reassign (declined in-place, succeeded elsewhere) is INFO — a
 * normal outcome, not a problem; an outright failure is WARN. Returns null when
 * there's nothing to say (the in-place agent was kept, or no candidate existed).
 */
export function rescheduleLogLine(input: {
  ok: boolean;
  bookingId: string | undefined;
  initiator: string;
  declineReason: orchestration.RescheduleDeclineReason | null | undefined;
  errorName?: string;
}): { level: "info" | "warn"; message: string } | null {
  if (input.ok) {
    if (!input.declineReason) return null;
    return {
      level: "info",
      message: `reschedule reassigned: booking=${input.bookingId ?? "?"} initiator=${input.initiator} in_place_declined=${input.declineReason}`,
    };
  }
  return {
    level: "warn",
    message: `reschedule failed: booking=${input.bookingId ?? "?"} initiator=${input.initiator} in_place_declined=${input.declineReason ?? "n/a"} error=${input.errorName ?? "unknown"}`,
  };
}

/** Emit the #543 success breadcrumb (INFO) when a reschedule reassigned away from
 *  the declined in-place agent. No-op when the agent was kept (declineReason null). */
function logRescheduleSuccess(
  bookingId: string,
  initiator: string,
  declineReason: orchestration.RescheduleDeclineReason | undefined,
): void {
  const line = rescheduleLogLine({ ok: true, bookingId, initiator, declineReason });
  if (line) console.info(line.message);
}

/** Emit the #543 failure breadcrumb (WARN) ONLY for a reschedule-reroute failure
 *  (the error carries the reschedule tag). A create/dedupe/not-found failure on the
 *  same call path is left alone so it isn't mislabeled as a reschedule failure. */
function logRescheduleFailure(err: unknown, initiator: string): void {
  const ctx = orchestration.rescheduleFailureContext(err);
  if (ctx.bookingId === undefined) return;
  const line = rescheduleLogLine({
    ok: false,
    bookingId: ctx.bookingId,
    initiator,
    declineReason: ctx.inPlaceDeclineReason,
    errorName: err instanceof Error ? err.name : String(err),
  });
  if (line) (line.level === "warn" ? console.warn : console.info)(line.message);
}

/**
 * Run a reschedule through the booking layer and emit the #543 breadcrumb. Shared
 * by the customer + admin entry points so the log decision lives in exactly one
 * place. Logging is here (the realDeps/IO layer), never in the pure layer.
 */
async function rescheduleWithLog(
  token: string,
  newStartIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  actor?: BookingActor,
): Promise<BookingResult> {
  try {
    const res = await orchestration.rescheduleBooking(
      token, newStartIso, reason, initiator, realDeps(), Date.now(), actor,
    );
    logRescheduleSuccess(res.booking.id, initiator, res.rescheduleDecline);
    return res;
  } catch (err) {
    logRescheduleFailure(err, initiator);
    throw err;
  }
}

export function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  return alertOnBookingFailure(() =>
    orchestration.createBooking(input, realDeps()),
  );
}

/**
 * Best-effort "you already have another call booked" lookup for the confirmation
 * screen (#626). Never throws: a lookup failure just yields no warning, so it can
 * never turn a successful booking into a failed one.
 */
export async function findDuplicateBookingWarning(input: {
  excludeBookingId: string;
  salesforceId: string | null;
  attendee: { email?: string; phone?: string };
}): Promise<orchestration.DuplicateWarning | null> {
  try {
    return await orchestration.findDuplicateWarning(input, realDeps());
  } catch {
    return null;
  }
}

/**
 * Direct booking API entry (#357): "one active appointment per person" — create,
 * dedupe, auto-reschedule, or ask-to-confirm. Wraps the orchestration in the same
 * verify-outage alerting as createBooking (the create/reschedule paths it dispatches
 * to both verify-on-book).
 */
export function bookViaApi(input: ApiBookingInput): Promise<ApiBookingResult> {
  return alertOnBookingFailure(async () => {
    try {
      const res = await orchestration.bookViaApi(input, realDeps());
      // Only a "rescheduled" outcome can carry a decline reason (#543).
      if (res.outcome === "rescheduled") {
        logRescheduleSuccess(res.booking.id, "system", res.rescheduleDecline);
      }
      return res;
    } catch (err) {
      logRescheduleFailure(err, "system");
      throw err;
    }
  });
}

/**
 * Dry run (#380): preview what an API booking would do without side effects.
 * NOT wrapped in the outage alerting — a dry run is a test, not a real lead, so
 * a dead-bucket preview shouldn't page anyone (the route still returns its code).
 */
export function previewBooking(input: ApiBookingInput): Promise<ApiBookingPreview> {
  return orchestration.previewBooking(input, realDeps());
}

/** Default reason stamped on an API cancel when the bot supplies none (#386). */
const API_CANCEL_REASON: ValidatedReason = { code: "api_cancellation", detail: null };

/** Lookup API (#386): a person's active bookings by strong id (email/phone null
 *  so only strong matches surface). */
export function lookupPersonBookings(identity: {
  externalId: string;
  salesforceId: string | null;
}): Promise<orchestration.ApiBookingView[]> {
  return orchestration.lookupPersonBookings(
    { externalId: identity.externalId, salesforceId: identity.salesforceId, email: null, phone: null },
    realDeps(),
  );
}

/** Lookup API (#386): one booking by id (any status, or asserted `status`). */
export function getPersonBookingById(input: {
  bookingId: string;
  identity: { externalId: string | null; salesforceId: string | null };
  status: BookingStatus | null;
}): Promise<orchestration.ApiBookingView> {
  return orchestration.getPersonBookingById(input, realDeps());
}

/** Cancel API (#386): cancel one owned booking by id. */
export function cancelDirectBooking(input: {
  bookingId: string;
  identity: { externalId: string | null; salesforceId: string | null };
  reason: ValidatedReason | null;
}): Promise<orchestration.ApiBookingView> {
  return orchestration.cancelDirectBooking(
    { bookingId: input.bookingId, identity: input.identity, reason: input.reason ?? API_CANCEL_REASON },
    realDeps(),
  );
}

/** #392 list (key-authed): cross-person filtered, paginated bookings. */
export function listBookings(query: import("@/lib/booking/api-request").ListQuery) {
  return orchestration.listBookings(query, realDeps());
}

export function rescheduleBooking(
  token: string,
  newStartIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
): Promise<BookingResult> {
  return alertOnBookingFailure(() =>
    rescheduleWithLog(token, newStartIso, reason, initiator),
  );
}

export async function cancelBooking(
  token: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
): Promise<void> {
  // Manage-link/admin cancel is idempotent: a re-cancel is a fine no-op, so the
  // transition flag is discarded here (only the direct API maps it to 404, #398).
  await orchestration.cancelBooking(token, reason, initiator, realDeps());
}

export function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  overrideCap = false,
) {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(), { overrideCap });
}

/** Resolve a booking's manage token by id, so admin actions can reuse the
 *  token-based reschedule/cancel flow (#326 admin screen). */
async function manageTokenForBooking(bookingId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("bookings")
    .select("manage_token")
    .eq("id", bookingId)
    .maybeSingle();
  return (data as { manage_token: string } | null)?.manage_token ?? null;
}

/**
 * Admin reschedule by booking id (#326): a staff member acts on a booking from
 * the admin screen. Reuses the customer reschedule flow (verify-on-book, history,
 * webhook) but stamps initiator='admin'. The route is requireAdmin-gated.
 */
export async function adminRescheduleBooking(
  bookingId: string,
  newStartIso: string,
  reason: ValidatedReason,
  actor: BookingActor,
): Promise<BookingResult> {
  const token = await manageTokenForBooking(bookingId);
  if (!token) throw new Error("Booking not found");
  return alertOnBookingFailure(() =>
    rescheduleWithLog(token, newStartIso, reason, "admin", actor),
  );
}

/** Admin cancel by booking id (#326), initiator='admin'. requireManager-gated.
 *  `actor` records WHICH staff user cancelled (#549). */
export async function adminCancelBooking(
  bookingId: string,
  reason: ValidatedReason,
  actor: BookingActor,
): Promise<void> {
  const token = await manageTokenForBooking(bookingId);
  if (!token) throw new Error("Booking not found");
  await orchestration.cancelBooking(token, reason, "admin", realDeps(), actor);
}

/**
 * Active agents for the manager reassign picker (#546): non-deactivated, non-test
 * users in the org, minimal fields only (never the full user row to the client).
 * The picker filters/sorts these with `rankReassignAgents`.
 */
export async function listActiveAgents(orgId: string): Promise<ReassignAgent[]> {
  const { data } = await supabaseAdmin()
    .from("users")
    .select("id, name, email, bookable")
    .eq("org_id", orgId)
    .eq("is_test", false)
    .is("deactivated_at", null);
  return (data as ReassignAgent[] | null) ?? [];
}

/**
 * Manager reassign by booking id (#546): force a booking onto a chosen agent from
 * the admin screen. Records initiator='admin' + the acting staff user (#549), and
 * allows targets OUTSIDE the bookable pool (coverage/escalation) — the manager
 * picks deliberately and the UI flags out-of-pool agents. `overrideCap` is set
 * only on the manager's second (two-step) confirm. requireBookingActor-gated.
 */
export function adminReassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  actor: BookingActor,
  overrideCap = false,
): Promise<BookingResult & { overCap: boolean }> {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(), {
    overrideCap,
    actor,
    initiator: "admin",
    allowNonBookable: true,
  });
}

export function completePastBookings(): Promise<number> {
  return orchestration.completePastBookings(realDeps());
}

export function getBookingByToken(token: string): Promise<BookingContext | null> {
  return orchestration.getBookingByToken(token, realDeps());
}

const PENDING_DELETION_ALERT_KEY = "pending_event_deletions";
const PENDING_DELETION_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** #401: drain the deletion retry queue and alert if any deletion is stuck. */
export async function processPendingEventDeletions(limit: number) {
  const res = await orchestration.processPendingEventDeletions(realDeps(), limit);
  if (res.stuck.length > 0) {
    await sendThrottledAlert(
      PENDING_DELETION_ALERT_KEY,
      PENDING_DELETION_ALERT_COOLDOWN_MS,
      `Slate: ${res.stuck.length} calendar event deletion(s) have failed ${orchestration.PENDING_DELETION_ALERT_AFTER}+ times and may be firing orphaned reminders. Check Google Calendar API health. Event ids: ${res.stuck.slice(0, 5).map((r) => r.gcal_event_id).join(", ")}`,
    ).catch(() => {});
  }
  return res;
}

const RECONCILE_ALERT_KEY = "reconcile_busy_blocks";
const RECONCILE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** Bound the recompute fan-out so one sweep can't blow the subrequest ceiling;
 *  any overflow buckets are caught by the recompute lane's freshness window. */
const RECONCILE_MAX_TOUCHED_BUCKETS = 25;

/**
 * #428 reconcile sweep: free busy_blocks whose booking is cancelled/missing so a
 * slot stuck busy after a crash self-heals, then recompute the affected buckets
 * (bounded) so the reopened slot shows in the embed promptly. Freeing anything
 * means a write-through delete was missed, so a throttled Slack note flags it
 * for visibility (not a page).
 */
export async function reconcileCancelledBusyBlocks(limit: number) {
  const res = await orchestration.reconcileCancelledBusyBlocks(realDeps(), limit);
  if (res.freed === 0) return res;

  // Map freed agents -> their buckets, dedupe, bound, recompute today's slots.
  const touched = new Set<string>();
  for (const userId of res.userIds) {
    try {
      for (const code of await bucketsForAgent(userId)) touched.add(code);
    } catch (err) {
      console.error(
        `reconcile: bucket lookup failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const code of [...touched].slice(0, RECONCILE_MAX_TOUCHED_BUCKETS)) {
    await recomputeBucketSlotsForToday(code, true).catch(() => {});
  }

  await sendThrottledAlert(
    RECONCILE_ALERT_KEY,
    RECONCILE_ALERT_COOLDOWN_MS,
    `Slate: reconcile freed ${res.freed} stuck busy_block(s) whose booking was cancelled/missing across ${res.userIds.length} agent(s). The slot(s) are now bookable again, but a write-through delete was missed. Check cancel-path health.`,
  ).catch(() => {});

  return res;
}

const RECONCILE_MISSING_ALERT_KEY = "reconcile_missing_busy_blocks";

/**
 * Reconcile-missing sweep (#431): re-create busy_blocks for active upcoming
 * bookings whose write-through INSERT was missed (the slot was showing free and
 * could be double-booked), then recompute those buckets so the slot flips busy
 * within ~1 min. Counterpart to reconcileCancelledBusyBlocks. Safe to run every
 * tick: the pure core only ever inserts (busy-over-free), never deletes.
 */
export async function reconcileMissingBusyBlocks(limit: number) {
  const res = await orchestration.reconcileMissingBusyBlocks(realDeps(), limit);
  if (res.recreated === 0) return res;

  // A missing block made the agent look free in EVERY bucket they serve, so
  // recompute all of each affected agent's buckets (deduped + bounded), exactly
  // as the #428 sweep does for freed agents - not just the booking's own bucket.
  const touched = new Set<string>();
  for (const userId of res.userIds) {
    try {
      for (const code of await bucketsForAgent(userId)) touched.add(code);
    } catch (err) {
      console.error(
        `reconcile-missing: bucket lookup failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const code of [...touched].slice(0, RECONCILE_MAX_TOUCHED_BUCKETS)) {
    await recomputeBucketSlotsForToday(code, true).catch(() => {});
  }

  await sendThrottledAlert(
    RECONCILE_MISSING_ALERT_KEY,
    RECONCILE_ALERT_COOLDOWN_MS,
    `Slate: re-created ${res.recreated} missing busy_block(s) for active booking(s) - a write-through INSERT had been missed, so the slot(s) were showing free and could have been double-booked. Now recomputed. Booking ids: ${res.bookingIds.slice(0, 10).join(", ")}${res.bookingIds.length > 10 ? " ..." : ""}. Check booking-path busy_block write health.`,
  ).catch(() => {});

  return res;
}

/**
 * #429 P2 drain: resume any undelivered booking-outbox row, re-running only its
 * not-done steps idempotently. Driven by the dedicated /api/cron/outbox lane. A
 * no-op until producers (P3/P4) write rows and register handlers.
 */
export async function drainBookingOutbox() {
  const result = await processBookingOutbox(
    realDeps(),
    OUTBOX_DRAIN_LIMIT,
    orchestration.OUTBOX_HANDLERS,
  );
  if (result.stuck.length > 0) {
    const ids = result.stuck.map((r) => r.id).slice(0, 10).join(", ");
    await sendThrottledAlert(
      "outbox_drain_stuck",
      DRAIN_ALERT_COOLDOWN_MS,
      `Slate: ${result.stuck.length} booking-outbox row(s) have failed >= ${DRAIN_ALERT_AFTER} delivery attempts and are backing off (a mutation's side effects - calendar/webhook - are not completing). Diagnose via booking_outbox.last_error; rows: ${ids}.`,
    ).catch(() => {});
  }
  // Return a PII-free summary: the full stuck rows carry attendee data in their
  // payload, and this flows into the cron HTTP response body.
  const { stuck, ...summary } = result;
  return { ...summary, stuck: stuck.length };
}

/**
 * #429 P4 (Phase C): resume create reservations whose booking crashed mid-create,
 * then sweep abandoned ones (delete-on-deliver keeps delivered rows from
 * lingering; this clears the rest, PII included). Driven by the /api/cron/outbox
 * lane next to the outbox drain.
 */
export async function drainBookingReservations() {
  const deps = realDeps();
  const result = await orchestration.processBookingReservations(
    deps,
    RESERVATION_DRAIN_LIMIT,
  );
  if (result.stuck.length > 0) {
    const ids = result.stuck.map((r) => r.id).slice(0, 10).join(", ");
    await sendThrottledAlert(
      "reservation_drain_stuck",
      DRAIN_ALERT_COOLDOWN_MS,
      `Slate: ${result.stuck.length} booking reservation(s) have failed >= ${DRAIN_ALERT_AFTER} completion attempts and are backing off (a crash-recovered create is not completing). Diagnose via booking_reservations.last_error; rows: ${ids}.`,
    ).catch(() => {});
  }
  // Retention: delete up to a batch of pending reservations older than the TTL.
  const cutoff = new Date(Date.now() - RESERVATION_RETENTION_MS).toISOString();
  await deps.deleteExpiredReservations(cutoff, RESERVATION_DRAIN_LIMIT).catch(() => {});
  // PII-free summary (stuck rows carry attendee payload -> cron response body).
  const { stuck, ...summary } = result;
  return { ...summary, stuck: stuck.length };
}

/**
 * GC abandoned reschedule lease-pins (#439, milestone #7) on the /api/cron/outbox
 * lane. Cleanup ONLY — enqueues a never-adopted reassign event for deletion and
 * frees the stale lock; it never completes or reassigns a booking.
 */
export async function sweepAbandonedReschedulePins() {
  return orchestration.processAbandonedReschedulePins(realDeps(), ABANDONED_PIN_GRACE_MS);
}
