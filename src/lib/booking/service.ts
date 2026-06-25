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
} from "@/lib/booking/core";
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
} from "@/lib/booking/orchestration";
import { toE164 } from "@/lib/phone";
import { noEligibleAgentsAlert } from "@/lib/availability/bucket-coverage";
import { emitWebhook } from "@/lib/webhooks/emit";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type {
  Booking,
  BookingEventInitiator,
  BookingStatus,
  BookingOutbox,
  Bucket,
  EventType,
  User,
} from "@/lib/db/types";
import { processBookingOutbox } from "@/lib/booking/outbox";

const CACHE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// A reschedule finishes in seconds; this TTL only governs reclaiming a lock
// orphaned by a torn-down Worker, so keep it comfortably above the slowest run.
const RESCHEDULE_LOCK_TTL_MS = 2 * 60 * 1000;
// Lease held while a drain processes one outbox row; only governs reclaiming a
// row orphaned by a torn-down Worker, so keep it above the slowest single-row run.
const OUTBOX_LEASE_TTL_MS = 2 * 60 * 1000;
const OUTBOX_DRAIN_LIMIT = 50;

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
  return (await isFree(email, startIso, endIso, ids.length ? ids : ["primary"]))
    ? "free"
    : "busy";
}

export {
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  BookingNotFoundError,
} from "@/lib/booking/orchestration";
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
    // Single-agent free check (reschedule keep-same-agent). Checks ALL the
    // agent's calendars; on a calendar-read failure (#314) it skips + alerts
    // rather than verifying primary-only and risking a double-book.
    isFree: async (email, startIso, endIso) =>
      (await checkAgentFree(email, startIso, endIso)) === "free",
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
      const { data, error } = await supabaseAdmin()
        .from("booking_outbox")
        .select("*")
        .eq("status", "pending")
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
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

    updateBooking: async (bookingId, patch) => {
      await supabaseAdmin().from("bookings").update(patch).eq("id", bookingId);
    },

    claimCancellation: async (bookingId) => {
      // Atomic flip active->cancelled (#413). Gating on the row not already being
      // cancelled means a concurrent cancel that already won touches 0 rows;
      // `.select` returns the row only when THIS call made the transition.
      const { data } = await supabaseAdmin()
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("id", bookingId)
        .neq("status", "cancelled")
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

    hasBookingEvent: async (bookingId, action, toStartsIso) => {
      const base = supabaseAdmin()
        .from("booking_events")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("action", action);
      const q =
        toStartsIso === null
          ? base.is("to_starts_at", null)
          : base.eq("to_starts_at", toStartsIso);
      const { data } = await q.limit(1).maybeSingle();
      return data != null;
    },

    getBookingEventId: async (bookingId, action, toStartsIso) => {
      const base = supabaseAdmin()
        .from("booking_events")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("action", action);
      const q =
        toStartsIso === null
          ? base.is("to_starts_at", null)
          : base.eq("to_starts_at", toStartsIso);
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
      if (email) queries.push(base().ilike("attendee_email", email));
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

export function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  return alertOnBookingFailure(() =>
    orchestration.createBooking(input, realDeps()),
  );
}

/**
 * Direct booking API entry (#357): "one active appointment per person" — create,
 * dedupe, auto-reschedule, or ask-to-confirm. Wraps the orchestration in the same
 * verify-outage alerting as createBooking (the create/reschedule paths it dispatches
 * to both verify-on-book).
 */
export function bookViaApi(input: ApiBookingInput): Promise<ApiBookingResult> {
  return alertOnBookingFailure(() => orchestration.bookViaApi(input, realDeps()));
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
    orchestration.rescheduleBooking(token, newStartIso, reason, initiator, realDeps()),
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
): Promise<BookingResult> {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps());
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
): Promise<BookingResult> {
  const token = await manageTokenForBooking(bookingId);
  if (!token) throw new Error("Booking not found");
  return alertOnBookingFailure(() =>
    orchestration.rescheduleBooking(token, newStartIso, reason, "admin", realDeps()),
  );
}

/** Admin cancel by booking id (#326), initiator='admin'. requireAdmin-gated. */
export async function adminCancelBooking(
  bookingId: string,
  reason: ValidatedReason,
): Promise<void> {
  const token = await manageTokenForBooking(bookingId);
  if (!token) throw new Error("Booking not found");
  await orchestration.cancelBooking(token, reason, "admin", realDeps());
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

/**
 * #429 P2 drain: resume any undelivered booking-outbox row, re-running only its
 * not-done steps idempotently. Driven by the dedicated /api/cron/outbox lane. A
 * no-op until producers (P3/P4) write rows and register handlers.
 */
export async function drainBookingOutbox() {
  return processBookingOutbox(
    realDeps(),
    OUTBOX_DRAIN_LIMIT,
    orchestration.OUTBOX_HANDLERS,
  );
}
