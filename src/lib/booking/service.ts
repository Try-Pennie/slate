import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/env";
import {
  resolveBucketByCode,
  roundRobinCandidates,
} from "@/lib/availability/service";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
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
  Bucket,
  EventType,
  User,
} from "@/lib/db/types";

const CACHE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// A reschedule finishes in seconds; this TTL only governs reclaiming a lock
// orphaned by a torn-down Worker, so keep it comfortably above the slowest run.
const RESCHEDULE_LOCK_TTL_MS = 2 * 60 * 1000;

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

    // Append-only reschedule/cancel/reassign history (#326/#300). A failed
    // insert must NOT fail the booking change (the move already happened) — log
    // + throttled alert, like the busy_blocks write-through (#34). The reason is
    // analytics, not a safety guard, so losing it to a rare DB error is OK.
    insertBookingEvent: async (row) => {
      const { error } = await supabaseAdmin().from("booking_events").insert(row);
      if (error) {
        console.error(
          `booking_events insert failed for booking ${row.booking_id} (${row.action}): ${error.message}`,
        );
        await sendThrottledAlert(
          "booking_event_insert",
          CACHE_ALERT_COOLDOWN_MS,
          `Slate: booking_events INSERT failed for booking ${row.booking_id} (${row.action}, ${error.message}). The reschedule/cancel reason for this action was not recorded.`,
        ).catch(() => {});
      }
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

    // Direct booking API person lookup (#357). One small indexed query PER
    // supplied identifier (not a single `.or(...)` string) so caller-supplied
    // values are parameterized by .eq/.ilike and can't inject PostgREST filter
    // syntax; results merge by id. The matcher re-grades confidence, so an
    // over-broad row here is harmless.
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

export function cancelBooking(
  token: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
): Promise<void> {
  return orchestration.cancelBooking(token, reason, initiator, realDeps());
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
  return orchestration.cancelBooking(token, reason, "admin", realDeps());
}

export function completePastBookings(): Promise<number> {
  return orchestration.completePastBookings(realDeps());
}

export function getBookingByToken(token: string): Promise<BookingContext | null> {
  return orchestration.getBookingByToken(token, realDeps());
}
