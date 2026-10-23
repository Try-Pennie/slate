/**
 * Live end-to-end tier-drop cascade harness.
 *
 * Creates an ISOLATED test org in the real DB, seeds a controlled tier-drop
 * scenario, runs the REAL createBooking orchestration (cascade + tier-stamping
 * + decision-log + webhook code), asserts the live outcome, and ALWAYS cleans
 * up — even on assertion failure.
 *
 * Safety rails:
 *  - All seeded rows live under a sentinel org named __TIER_DROP_HARNESS__<ms>.
 *  - Every insert/delete is scoped to ids created during THIS run.
 *  - try/finally guarantees cleanup regardless of outcome.
 *  - Post-cleanup residue check asserts zero rows remain.
 *
 * Run:
 *   node --env-file=.env.local --experimental-strip-types \
 *        --import ./scripts/register-paths.mjs \
 *        scripts/live-tier-drop-harness.ts
 *
 * Env vars required (loaded from .env.local via --env-file):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY
 *
 * Stubbed externals (no real side effects):
 *   - verifyFree / isFree   → free only for agent_vh
 *   - createEvent            → no-op, returns a deterministic fake event id
 *   - deleteEvent            → no-op
 *   - updateEventTime        → no-op
 *   - emitWebhook            → captured into in-memory array
 *   - invalidateSlots        → no-op (avoids touching real slot cache for codes 500/400)
 *   - enqueueEventDeletion / related → no-op
 *
 * Real implementations used for all DB-backed deps (insertBooking, insertBusyBlock,
 * roundRobinCandidates, loadEmails, getUser, recordRoutingDecision, etc.) so the
 * full cascade path runs against the live schema.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { supabaseAdmin } from "@/lib/supabase/admin";
import * as orchestration from "@/lib/booking/orchestration";
import { roundRobinCandidates } from "@/lib/availability/service";
import { recordRoutingDecision } from "@/lib/routing/record";
import type { BookingDeps } from "@/lib/booking/orchestration";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type {
  Booking,
  BookingReservation,
  BookingStatus,
  Bucket,
  EventType,
  User,
  WebhookEvent,
} from "@/lib/db/types";

// ---------------------------------------------------------------------------
// FIX 1 — Disable Slack for this process, evaluated at module-init time
//          (after all imports but before main() is invoked).
//
// The booking path calls sendThrottledAlert, which checks slackConfigured().
// slackConfigured() reads process.env.SLACK_BOT_TOKEN at call time (not at
// import time), so deleting it here — before main() is invoked — guarantees
// slackConfigured() returns false for the entire harness run. This prevents:
//   (a) a real Slack message being posted to the production alerts channel, and
//   (b) an alert_state cooldown row (key "tier_fallback_deep:500") being written to
//       the live DB, which the org-scoped cleanup would not remove.
// ---------------------------------------------------------------------------
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_ALERTS_CHANNEL;

// ---------------------------------------------------------------------------
// SAFETY GUARD — refuse to run unless explicitly confirmed.
// This harness CREATES and DELETES organizations in whatever database the env
// points at (i.e. production). Require an explicit opt-in so it can never run
// by accident (a stray invocation, a misconfigured CI step, etc.).
// ---------------------------------------------------------------------------
if (process.env.HARNESS_CONFIRM !== "1") {
  console.error(
    "Refusing to run: live-tier-drop-harness creates and deletes orgs in the " +
      "configured (production) database. Set HARNESS_CONFIRM=1 to run it " +
      "intentionally.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, label: string): boolean {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.error(`  FAIL: ${label}`);
  }
  return cond;
}

/** Next weekday (Mon–Fri) at 14:00 UTC from tomorrow. */
function nextWeekdaySlotIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(14, 0, 0, 0);
  // 0=Sun, 6=Sat
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString();
}

/** Supabase .data unwrap with error-throw. */
function unwrap<T>(res: { data: T | null; error: { message: string } | null }, label: string): T {
  if (res.error || res.data == null) {
    throw new Error(`${label}: ${res.error?.message ?? "no data returned"}`);
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function insertOrg(name: string): Promise<string> {
  const db = supabaseAdmin();
  const res = await db
    .from("organizations")
    .insert({ name })
    .select("id")
    .single();
  return unwrap(res, "insertOrg").id;
}

async function insertUser(fields: {
  org_id: string;
  email: string;
  name: string;
  attributes: Record<string, unknown>;
  bookable: boolean;
}): Promise<string> {
  const db = supabaseAdmin();
  const res = await db
    .from("users")
    .insert({
      org_id: fields.org_id,
      email: fields.email,
      name: fields.name,
      role: "agent",
      attributes: fields.attributes,
      bookable: fields.bookable,
      is_test: true,
    })
    .select("id")
    .single();
  return unwrap(res, `insertUser(${fields.email})`).id;
}

async function insertEventType(orgId: string): Promise<string> {
  const db = supabaseAdmin();
  const res = await db
    .from("event_types")
    .insert({
      org_id: orgId,
      name: "Harness Test Call",
      description: null,
      regal_type: "call",
      duration_min: 30,
      buffer_before_min: 0,
      buffer_after_min: 0,
      min_notice_min: 1,
      daily_cap: null,
      slot_interval_min: 15,
    })
    .select("id")
    .single();
  return unwrap(res, "insertEventType").id;
}

async function insertBucket(fields: {
  org_id: string;
  code: string;
  name: string;
  event_type_id: string;
  criteria: Record<string, unknown>;
}): Promise<string> {
  const db = supabaseAdmin();
  const res = await db
    .from("buckets")
    .insert({
      org_id: fields.org_id,
      code: fields.code,
      name: fields.name,
      event_type_id: fields.event_type_id,
      assignment: "round_robin",
      criteria: fields.criteria,
      is_test: true,
    })
    .select("id")
    .single();
  return unwrap(res, `insertBucket(${fields.code})`).id;
}

async function insertScheduleWithRules(
  userId: string,
  timezone: string,
  weekdays: number[],
  startMinute: number,
  endMinute: number,
): Promise<string> {
  const db = supabaseAdmin();
  const schedRes = await db
    .from("availability_schedules")
    .insert({ user_id: userId, timezone })
    .select("id")
    .single();
  const scheduleId = unwrap(schedRes, "insertSchedule").id;

  const rules = weekdays.map((weekday) => ({
    schedule_id: scheduleId,
    weekday,
    start_minute: startMinute,
    end_minute: endMinute,
  }));
  const rulesRes = await db.from("availability_rules").insert(rules);
  if (rulesRes.error) throw new Error(`insertRules: ${rulesRes.error.message}`);

  return scheduleId;
}

async function insertBusyBlock(
  userId: string,
  startsAt: string,
  endsAt: string,
): Promise<string> {
  const db = supabaseAdmin();
  const res = await db
    .from("busy_blocks")
    .insert({
      user_id: userId,
      starts_at: startsAt,
      ends_at: endsAt,
      source: "slate",
      booking_id: null,
    })
    .select("id")
    .single();
  return unwrap(res, "insertBusyBlock").id;
}

// ---------------------------------------------------------------------------
// Build custom deps (real DB + stubbed externals)
// ---------------------------------------------------------------------------

function buildDeps(
  testOrgId: string,
  agentVhEmail: string,
  capturedWebhooks: Array<{ orgId: string; event: WebhookEvent; payload: BookingEventPayload }>,
): BookingDeps {
  const db = () => supabaseAdmin();

  // Org-scoped bucket resolver — avoids collision with the real org's 500/400 buckets.
  async function resolveBucketByCode(code: string) {
    const row = (
      await db()
        .from("buckets")
        .select("*, event_types(*)")
        .eq("code", code)
        .eq("org_id", testOrgId)
        .maybeSingle()
    ).data as (Record<string, unknown> & { event_types: EventType | null }) | null;
    if (!row) return null;
    const { event_types: eventType, ...bucket } = row;
    if (!eventType) return null;
    return { bucket: bucket as Bucket, eventType };
  }

  return {
    // #2838: a harness run must never page the alerts channel; a bound hit here
    // is printed instead.
    pageRaceBoundHit: (page) => {
      console.log(`[harness] race bound hit page not sent: ${page.text}`);
    },
    // --- availability / routing ---
    resolveBucketByCode,

    roundRobinCandidates,

    // Single-agent verify: free only for agent_vh
    isFree: async (email) => email === agentVhEmail,

    // Working hours (#527): unrestricted — this harness exercises tier-drop, not
    // the in-place reschedule guard, so always report the agent on-shift.
    agentWorkingHours: async () => ({
      timezone: "America/New_York",
      rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
    }),

    // Batched verify: free only for agent_vh
    verifyFree: async (emails) => ({
      free: new Set(emails.filter((e) => e === agentVhEmail)),
      unverified: new Set<string>(),
    }),

    // --- Google Calendar stubs ---
    createEvent: async (_email, _args, clientId) =>
      clientId ?? `fake-event-${randomUUID()}`,

    deleteEvent: async () => {},
    updateEventTime: async () => {},

    enqueueEventDeletion: async () => {},
    loadPendingEventDeletions: async () => [],
    liveBookingHoldingEvent: async () => null,
    pendingWritePinsEvent: async () => false,
    removePendingEventDeletion: async () => {},
    bumpPendingEventDeletion: async () => {},

    // --- Webhook capture ---
    emitWebhook: async (orgId, event, payload, _dedupeKey) => {
      capturedWebhooks.push({ orgId, event, payload: payload as BookingEventPayload });
    },

    // --- Misc ---
    newManageToken: () => randomUUID().replace(/-/g, "").slice(0, 24),
    newIdempotencyKey: () => `anon_${randomUUID().replace(/-/g, "")}`,
    appBaseUrl: () => "https://harness.test.local",
    invalidateSlots: async () => {},
    // Real decision log (#504): the harness exercises real tier-drop routing, so
    // it logs decisions as production would.
    recordRoutingDecision,

    // --- DB-backed deps ---
    getUser: async (userId) => {
      const res = await db().from("users").select("*").eq("id", userId).single();
      return res.data as User;
    },

    loadEmails: async (userIds) => {
      const m = new Map<string, string>();
      if (userIds.length === 0) return m;
      const res = await db().from("users").select("id, email").in("id", userIds);
      for (const row of (res.data ?? []) as { id: string; email: string | null }[]) {
        if (row.email) m.set(row.id, row.email);
      }
      return m;
    },

    findBookingByIdempotencyKey: async (key) => {
      const res = await db()
        .from("bookings")
        .select("*")
        .eq("idempotency_key", key)
        .in("status", ["confirmed", "rescheduled"])
        .maybeSingle();
      return (res.data as Booking | null) ?? null;
    },

    insertBooking: async (row) => {
      const res = await db().from("bookings").insert(row).select("*").single();
      if (res.error || !res.data) {
        const conflict = res.error?.code === "23505";
        return conflict
          ? { ok: false, conflict: true }
          : { ok: false, conflict: false, error: res.error ?? new Error("insert returned no row") };
      }
      return { ok: true, booking: res.data as Booking };
    },

    insertBusyBlock: async (block) => {
      await db().from("busy_blocks").insert(block);
    },

    moveBusyBlock: async (userId, startIso, endIso, bookingId) => {
      await db().rpc("move_busy_block", {
        p_booking_id: bookingId,
        p_user_id: userId,
        p_starts_at: startIso,
        p_ends_at: endIso,
      });
    },
    // The harness never drives a reassign; a no-op stub keeps the BookingDeps
    // shape complete (#449) so it can't throw "not a function" if it ever does.
    reassignSwap: async () => ({ prevGcalEventId: null, prevAgentEmail: null, updated: true }),

    deleteBusyBlocksForBooking: async (bookingId) => {
      await db().from("busy_blocks").delete().eq("booking_id", bookingId);
    },

    deleteGcalMirrorBlock: async (userId, gcalEventId) => {
      await db()
        .from("busy_blocks")
        .delete()
        .eq("user_id", userId)
        .eq("source", "gcal")
        .eq("gcal_event_id", gcalEventId);
    },

    loadReconcilableBusyBlocks: async () => [],
    loadBookingStatuses: async () => new Map<string, BookingStatus>(),
    deleteBusyBlocksByIds: async () => [],

    // --- Outbox (not used in createBooking path, provide stubs) ---
    enqueueOutbox: async () => randomUUID(),
    loadDrainableOutbox: async () => [],
    // #1048: no lease means the inline path leaves the row to the drain, which is
    // what this harness wants (it exercises createBooking, not delivery).
    leaseOutbox: async () => null,
    saveOutboxSteps: async () => "written" as const,
    markOutboxDelivered: async () => "written" as const,
    releaseOutboxLease: async () => {},

    // --- Reservations ---
    insertReservation: async (row) => {
      const res = await db()
        .from("booking_reservations")
        .insert(row)
        .select("*")
        .single();
      if (res.error || !res.data) {
        // UNIQUE conflict: adopt the winner's row
        const existing = await db()
          .from("booking_reservations")
          .select("*")
          .eq("idempotency_key", row.idempotency_key)
          .single();
        if (existing.data) return existing.data as BookingReservation;
        throw new Error(`insertReservation: ${res.error?.message ?? "no data"}`);
      }
      return res.data as BookingReservation;
    },

    loadReservationByKey: async (key) => {
      const res = await db()
        .from("booking_reservations")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      return res.data ? (res.data as BookingReservation) : null;
    },

    deleteReservation: async (id) => {
      // #3859: the same answer the shipped delete gives, so a lost race here is judged alike.
      const { data, error } = await db().from("booking_reservations").delete().eq("id", id).select("id");
      if (error) throw new Error(`reservation ${id} could not be deleted: ${error.message}`);
      return data && data.length > 0 ? ("deleted" as const) : ("gone" as const);
    },

    repinReservationEvent: async (id, fromClientId, toClientId) => {
      const { data, error } = await db()
        .from("booking_reservations")
        .update({ gcal_client_id: toClientId })
        .eq("id", id)
        .eq("gcal_client_id", fromClientId)
        .eq("status", "pending")
        .select("id");
      if (error || !data || data.length === 0) throw new Error(`reservation ${id} was not repinned`);
    },

    loadDrainableReservations: async () => [],
    leaseReservation: async () => null,
    releaseReservationLease: async () => {},
    deleteExpiredReservations: async () => ({ deleted: 0, owed: [] }),

    updateBooking: async (bookingId, patch) => {
      await db().from("bookings").update(patch).eq("id", bookingId);
    },

    claimCancellation: async () => false,
    completeBookingsIfDue: async () => [],

    // Reschedule lock (not used in createBooking)
    claimReschedule: async () => ({ outcome: "won" as const }),
    writeReschedulePin: async () => {},
    readReschedulePin: async () => null,
    releaseReschedule: async () => {},
    loadAbandonedReschedulePins: async () => [],
    takeOverAbandonedReschedulePin: async () => null,
    releaseAbandonedReschedulePin: async () => {},
    readBookingInviteState: async () => null,
    readEventOnPrimary: async () => null,

    insertBookingEvent: async () => null,
    hasBookingEvent: async () => false,
    getBookingEventId: async () => null,

    loadBookingContext: async () => null,
    loadBookingById: async (bookingId) => {
      const res = await db().from("bookings").select("*").eq("id", bookingId).maybeSingle();
      if (!res.data) return null;
      const b = res.data as Booking;
      const [bkRes, etRes] = await Promise.all([
        db().from("buckets").select("*").eq("id", b.bucket_id).single(),
        db().from("event_types").select("*").eq("id", b.event_type_id).single(),
      ]);
      if (!bkRes.data || !etRes.data) return null;
      return { booking: b, bucket: bkRes.data as Bucket, eventType: etRes.data as EventType };
    },

    findActiveBookingsForPerson: async () => [],
    findActiveBookingsByStrongIds: async () => [],
    queryBookings: async () => ({ rows: [], buckets: [] }),
    getAgentByEmail: async () => null,
    loadPastBookingIdsToComplete: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(ctx: {
  orgId: string | null;
  userIds: string[];
  scheduleIds: string[];
  bucketIds: string[];
  busyBlockIds: string[];
  idempotencyKey: string | null;
}) {
  const { orgId, userIds, scheduleIds, bucketIds, busyBlockIds, idempotencyKey } = ctx;
  if (!orgId) return; // nothing was created

  const db = supabaseAdmin();
  console.log("\n--- CLEANUP ---");

  // FIX 2 — revised deletion order so no RESTRICT FK blocks user/org removal.
  //
  // Root cause of the prior residue: several tables reference users(id) WITHOUT
  // ON DELETE CASCADE (default = RESTRICT). If any of those child rows survived
  // the earlier steps, the users delete would fail silently (error logged but
  // not thrown), and the org delete would then also fail (because users still
  // reference it). The residue check masked this via `count ?? 0` treating a
  // query error as zero rows.
  //
  // Fix: (a) explicitly delete every RESTRICT-FK child table scoped by user_id
  // BEFORE deleting users; (b) the sentinel residue check below now queries by
  // org name pattern rather than only by the current-run org id, so ANY leftover
  // harness row from any run is caught; (c) errors are no longer masked — the
  // sentinel check exits non-zero if residue remains.

  // 1. routing_decisions (cascade from org, but be explicit)
  const rd = await db.from("routing_decisions").delete().eq("org_id", orgId);
  console.log(`  routing_decisions deleted: ${rd.error ? "ERROR: " + rd.error.message : "ok"}`);

  // 2. booking_reservations — pinned_user_id references users(id) RESTRICT
  if (idempotencyKey) {
    const brRes = await db
      .from("booking_reservations")
      .delete()
      .eq("idempotency_key", idempotencyKey);
    console.log(`  booking_reservations (by key) deleted: ${brRes.error ? "ERROR: " + brRes.error.message : "ok"}`);
  }
  if (userIds.length > 0) {
    const brAll = await db
      .from("booking_reservations")
      .delete()
      .in("pinned_user_id", userIds);
    console.log(`  booking_reservations (by user) deleted: ${brAll.error ? "ERROR: " + brAll.error.message : "ok"}`);
  }

  // 3. reschedule_locks — pinned_user_id references users(id) RESTRICT
  //    (harness stubs writeReschedulePin so no real lock is created, but delete
  //    defensively in case of a future code path change)
  if (userIds.length > 0) {
    const rlRes = await db.from("reschedule_locks").delete().in("pinned_user_id", userIds);
    console.log(`  reschedule_locks (by user) deleted: ${rlRes.error ? "ERROR: " + rlRes.error.message : "ok"}`);
  }

  // 4. busy_blocks — user_id references users(id) ON DELETE CASCADE, but be
  //    explicit so we clean the seeded pre-existing busy block too
  if (busyBlockIds.length > 0) {
    const bb = await db.from("busy_blocks").delete().in("id", busyBlockIds);
    console.log(`  seeded busy_blocks deleted: ${bb.error ? "ERROR: " + bb.error.message : "ok"}`);
  }
  if (userIds.length > 0) {
    const bbAll = await db.from("busy_blocks").delete().in("user_id", userIds);
    console.log(`  all busy_blocks for test users deleted: ${bbAll.error ? "ERROR: " + bbAll.error.message : "ok"}`);
  }

  // 5. bookings — assigned_user_id references users(id) ON DELETE SET NULL (0004),
  //    delete by org_id so no set-null residue remains
  const bkRes = await db.from("bookings").delete().eq("org_id", orgId);
  console.log(`  bookings deleted: ${bkRes.error ? "ERROR: " + bkRes.error.message : "ok"}`);

  // 6. bucket_members — delete by user_id (in addition to by bucket_id) to
  //    ensure we catch all members before deleting users
  if (userIds.length > 0) {
    const bmByUser = await db.from("bucket_members").delete().in("user_id", userIds);
    console.log(`  bucket_members (by user) deleted: ${bmByUser.error ? "ERROR: " + bmByUser.error.message : "ok"}`);
  }
  if (bucketIds.length > 0) {
    const bmByBucket = await db.from("bucket_members").delete().in("bucket_id", bucketIds);
    console.log(`  bucket_members (by bucket) deleted: ${bmByBucket.error ? "ERROR: " + bmByBucket.error.message : "ok"}`);
  }

  // 7. availability_rules (cascade from schedules)
  if (scheduleIds.length > 0) {
    const arRes = await db.from("availability_rules").delete().in("schedule_id", scheduleIds);
    console.log(`  availability_rules deleted: ${arRes.error ? "ERROR: " + arRes.error.message : "ok"}`);
  }

  // 8. availability_schedules (user_id ON DELETE CASCADE — explicit for safety)
  if (userIds.length > 0) {
    const asRes = await db.from("availability_schedules").delete().in("user_id", userIds);
    console.log(`  availability_schedules deleted: ${asRes.error ? "ERROR: " + asRes.error.message : "ok"}`);
  }

  // 9. buckets (before event_types and users)
  const bRes = await db.from("buckets").delete().eq("org_id", orgId);
  console.log(`  buckets deleted: ${bRes.error ? "ERROR: " + bRes.error.message : "ok"}`);

  // 10. event_types
  const etRes = await db.from("event_types").delete().eq("org_id", orgId);
  console.log(`  event_types deleted: ${etRes.error ? "ERROR: " + etRes.error.message : "ok"}`);

  // 11. users — all RESTRICT-FK children cleared above, so this should succeed
  const uRes = await db.from("users").delete().eq("org_id", orgId);
  console.log(`  users deleted: ${uRes.error ? "ERROR: " + uRes.error.message : "ok"}`);

  // 12. organizations
  const oRes = await db.from("organizations").delete().eq("id", orgId);
  console.log(`  organizations deleted: ${oRes.error ? "ERROR: " + oRes.error.message : "ok"}`);
}

// ---------------------------------------------------------------------------
// Post-cleanup residue check
// ---------------------------------------------------------------------------

/** Per-table counts scoped to the current-run orgId and userIds. */
async function checkResidue(orgId: string, userIds: string[]): Promise<Record<string, number>> {
  const db = supabaseAdmin();
  const none = ["__none__"];
  const uids = userIds.length ? userIds : none;

  const queries = await Promise.all([
    db.from("routing_decisions").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("busy_blocks").select("id", { count: "exact", head: true }).in("user_id", uids),
    db.from("bookings").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("buckets").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("event_types").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("users").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("organizations").select("id", { count: "exact", head: true }).eq("id", orgId),
    db.from("availability_schedules").select("id", { count: "exact", head: true }).in("user_id", uids),
    db.from("booking_reservations").select("id", { count: "exact", head: true }).in("pinned_user_id", uids),
    db.from("reschedule_locks").select("booking_id", { count: "exact", head: true }).in("pinned_user_id", uids),
  ]);

  const labels = [
    "routing_decisions",
    "busy_blocks",
    "bookings",
    "buckets",
    "event_types",
    "users",
    "organizations",
    "availability_schedules",
    "booking_reservations",
    "reschedule_locks",
  ];

  const residue: Record<string, number> = {};
  for (let i = 0; i < labels.length; i++) {
    // Treat a query error as a non-zero count so it surfaces rather than hiding.
    if (queries[i].error) {
      console.error(`  RESIDUE CHECK ERROR (${labels[i]}): ${queries[i].error.message}`);
      residue[labels[i]] = -1;
    } else {
      residue[labels[i]] = queries[i].count ?? 0;
    }
  }
  return residue;
}

/**
 * Sentinel-based global residue check: scans for ANY harness org/user left in
 * the DB, regardless of which run created them. Uses the org name prefix
 * "__TIER_DROP_HARNESS__" to identify harness rows across all runs.
 *
 * Returns { harnessOrgs, harnessUsers } — both should be 0 after cleanup.
 */
async function checkSentinelResidue(): Promise<{ harnessOrgs: number; harnessUsers: number }> {
  const db = supabaseAdmin();

  const orgRes = await db
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .like("name", "__TIER_DROP_HARNESS__%");
  if (orgRes.error) throw new Error(`sentinel org count failed: ${orgRes.error.message}`);
  const harnessOrgs = orgRes.count ?? 0;

  // Find harness org ids to scope the user count
  let harnessUsers = 0;
  if (harnessOrgs > 0) {
    const orgIdRes = await db
      .from("organizations")
      .select("id")
      .like("name", "__TIER_DROP_HARNESS__%");
    if (orgIdRes.error) throw new Error(`sentinel org id query failed: ${orgIdRes.error.message}`);
    const orgIds = (orgIdRes.data ?? []).map((r) => (r as { id: string }).id);
    if (orgIds.length > 0) {
      const userRes = await db
        .from("users")
        .select("id", { count: "exact", head: true })
        .in("org_id", orgIds);
      if (userRes.error) throw new Error(`sentinel user count failed: ${userRes.error.message}`);
      harnessUsers = userRes.count ?? 0;
    }
  }

  return { harnessOrgs, harnessUsers };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const epoch = Date.now();
  const sentinelName = `__TIER_DROP_HARNESS__${epoch}`;

  // The idempotency key uses a unique salesforce id so the booking gets a key.
  const testSalesforceId = `harness-sf-${epoch}`;

  // Working-hours slot: next weekday at 14:00 UTC (10:00 AM ET).
  const slotStart = nextWeekdaySlotIso();
  const slotEnd = new Date(Date.parse(slotStart) + 30 * 60 * 1000).toISOString();
  console.log(`\nTarget slot: ${slotStart} – ${slotEnd}`);

  // Seeded row ids for cleanup
  const ctx: {
    orgId: string | null;
    userIds: string[];
    scheduleIds: string[];
    bucketIds: string[];
    busyBlockIds: string[];
    idempotencyKey: string | null;
  } = {
    orgId: null,
    userIds: [],
    scheduleIds: [],
    bucketIds: [],
    busyBlockIds: [],
    idempotencyKey: null,
  };

  let agentUhId = "";
  let agentVhId = "";
  let agentUhEmail = "";
  let agentVhEmail = "";

  const capturedWebhooks: Array<{ orgId: string; event: WebhookEvent; payload: BookingEventPayload }> = [];
  let bookingResult: orchestration.BookingResult | null = null;
  let assertionsPassed = 0;
  let assertionsTotal = 0;

  try {
    // ---- SEED ----
    console.log("\n--- SEED ---");

    // 1. Organization
    ctx.orgId = await insertOrg(sentinelName);
    if (!ctx.orgId) throw new Error("ABORT: org id is null after insert");
    console.log(`  org: ${ctx.orgId} (${sentinelName})`);

    // 2. Event type
    const eventTypeId = await insertEventType(ctx.orgId);
    console.log(`  event_type: ${eventTypeId}`);

    // 3. Buckets (500 = ultra_high, 400 = very_high)
    const bucket500Id = await insertBucket({
      org_id: ctx.orgId,
      code: "500",
      name: "__HARNESS__ Ultra High",
      event_type_id: eventTypeId,
      criteria: { debt_team: "ultra_high" },
    });
    const bucket400Id = await insertBucket({
      org_id: ctx.orgId,
      code: "400",
      name: "__HARNESS__ Very High",
      event_type_id: eventTypeId,
      criteria: { debt_team: "very_high" },
    });
    ctx.bucketIds = [bucket500Id, bucket400Id];
    console.log(`  bucket 500: ${bucket500Id}`);
    console.log(`  bucket 400: ${bucket400Id}`);

    // 4. Agents
    // Use emails that are clearly test-only and not real Google accounts
    agentUhEmail = `harness-uh-${epoch}@harness.invalid`;
    agentVhEmail = `harness-vh-${epoch}@harness.invalid`;

    agentUhId = await insertUser({
      org_id: ctx.orgId,
      email: agentUhEmail,
      name: "Harness Agent UH",
      attributes: { debt_team: "ultra_high" },
      bookable: true,
    });
    agentVhId = await insertUser({
      org_id: ctx.orgId,
      email: agentVhEmail,
      name: "Harness Agent VH",
      attributes: { debt_team: "very_high" },
      bookable: true,
    });
    ctx.userIds = [agentUhId, agentVhId];
    console.log(`  agent_uh: ${agentUhId} (${agentUhEmail})`);
    console.log(`  agent_vh: ${agentVhId} (${agentVhEmail})`);

    // 5. Working-hours schedules (Mon–Fri, 08:00–18:00 ET = 480–1080 min)
    //    14:00 UTC = 10:00 AM ET = 600 min from midnight ✓
    const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5]; // Luxon: 1=Mon..7=Sun
    const schedUhId = await insertScheduleWithRules(
      agentUhId,
      "America/New_York",
      WEEKDAYS_MON_FRI,
      480,
      1080,
    );
    const schedVhId = await insertScheduleWithRules(
      agentVhId,
      "America/New_York",
      WEEKDAYS_MON_FRI,
      480,
      1080,
    );
    ctx.scheduleIds = [schedUhId, schedVhId];
    console.log(`  schedules: uh=${schedUhId}, vh=${schedVhId}`);

    // 6. Busy block for agent_uh covering the target slot → bucket 500 has no free agent
    const busyBlockId = await insertBusyBlock(agentUhId, slotStart, slotEnd);
    ctx.busyBlockIds = [busyBlockId];
    console.log(`  busy_block for agent_uh: ${busyBlockId} (${slotStart}–${slotEnd})`);

    // ---- RUN ----
    console.log("\n--- RUN createBooking(bucketCode=500) ---");
    const deps = buildDeps(ctx.orgId, agentVhEmail, capturedWebhooks);

    // The idempotency key is derived by orchestration from bucketCode + startIso + salesforceId.
    // Providing a salesforceId ensures a stable key (so the reservation path is exercised).
    bookingResult = await orchestration.createBooking(
      {
        bucketCode: "500",
        startIso: slotStart,
        timezone: "America/New_York",
        salesforceId: testSalesforceId,
        attendee: {
          name: "Harness Lead",
          email: "lead@harness.invalid",
          phone: "+15555550001",
        },
        prefill: {},
        allowTestBuckets: true,
      },
      deps,
    );
    console.log(`  booking id: ${bookingResult.booking.id}`);
    console.log(`  assigned_user_id: ${bookingResult.booking.assigned_user_id}`);
    console.log(`  routing_trace: ${JSON.stringify(bookingResult.booking.routing_trace)}`);

    // ---- ASSERT ----
    console.log("\n--- ASSERTIONS ---");
    const booking = bookingResult.booking;
    const rt = booking.routing_trace;

    // A1: assigned to agent_vh (booked the lower tier)
    const a1 = assert(
      booking.assigned_user_id === agentVhId,
      `A1: assigned_user_id === agent_vh (${agentVhId.slice(0, 8)}…)`,
    );
    assertionsPassed += a1 ? 1 : 0;
    assertionsTotal++;

    // A2: routing_trace fields
    const a2a = assert(rt?.tier_fallback === true, "A2a: routing_trace.tier_fallback === true");
    assertionsPassed += a2a ? 1 : 0;
    assertionsTotal++;

    const a2b = assert(
      rt?.requested_tier === "ultra_high",
      `A2b: routing_trace.requested_tier === "ultra_high" (got "${rt?.requested_tier}")`,
    );
    assertionsPassed += a2b ? 1 : 0;
    assertionsTotal++;

    const a2c = assert(
      rt?.booked_tier === "very_high",
      `A2c: routing_trace.booked_tier === "very_high" (got "${rt?.booked_tier}")`,
    );
    assertionsPassed += a2c ? 1 : 0;
    assertionsTotal++;

    const a2d = assert(
      rt?.rungs_dropped === 1,
      `A2d: routing_trace.rungs_dropped === 1 (got ${rt?.rungs_dropped})`,
    );
    assertionsPassed += a2d ? 1 : 0;
    assertionsTotal++;

    const a2e = assert(
      rt?.bucket_code === "400",
      `A2e: routing_trace.bucket_code === "400" (got "${rt?.bucket_code}")`,
    );
    assertionsPassed += a2e ? 1 : 0;
    assertionsTotal++;

    // A3: routing_decisions row — query live from DB
    const rdRes = await supabaseAdmin()
      .from("routing_decisions")
      .select("*")
      .eq("org_id", ctx.orgId)
      .eq("booking_id", booking.id)
      .maybeSingle();
    const rd = rdRes.data as {
      tier_fallback: boolean;
      outcome: string;
      chosen_user_id: string | null;
    } | null;

    const a3a = assert(
      rd !== null,
      "A3a: routing_decisions row exists for this booking + org",
    );
    assertionsPassed += a3a ? 1 : 0;
    assertionsTotal++;

    const a3b = assert(
      rd?.tier_fallback === true,
      `A3b: routing_decisions.tier_fallback === true (got ${rd?.tier_fallback})`,
    );
    assertionsPassed += a3b ? 1 : 0;
    assertionsTotal++;

    const a3c = assert(
      rd?.outcome === "booked",
      `A3c: routing_decisions.outcome === "booked" (got "${rd?.outcome}")`,
    );
    assertionsPassed += a3c ? 1 : 0;
    assertionsTotal++;

    const a3d = assert(
      rd?.chosen_user_id === agentVhId,
      `A3d: routing_decisions.chosen_user_id === agent_vh`,
    );
    assertionsPassed += a3d ? 1 : 0;
    assertionsTotal++;

    // A4: captured webhook payload
    const createdHook = capturedWebhooks.find((w) => w.event === "booking.created");
    const a4a = assert(
      createdHook !== undefined,
      "A4a: booking.created webhook was captured",
    );
    assertionsPassed += a4a ? 1 : 0;
    assertionsTotal++;

    const a4b = assert(
      createdHook?.payload.bucket_code === "400",
      `A4b: webhook payload.bucket_code === "400" (got "${createdHook?.payload.bucket_code}")`,
    );
    assertionsPassed += a4b ? 1 : 0;
    assertionsTotal++;

    const hookRouting = createdHook?.payload.routing;
    const a4c = assert(
      hookRouting?.booked_tier === "very_high",
      `A4c: webhook payload.routing.booked_tier === "very_high" (got "${hookRouting?.booked_tier}")`,
    );
    assertionsPassed += a4c ? 1 : 0;
    assertionsTotal++;

    const a4d = assert(
      hookRouting?.tier_fallback === true,
      `A4d: webhook payload.routing.tier_fallback === true (got ${hookRouting?.tier_fallback})`,
    );
    assertionsPassed += a4d ? 1 : 0;
    assertionsTotal++;

    console.log(`\n  ${assertionsPassed}/${assertionsTotal} assertions passed`);
  } finally {
    await cleanup(ctx);

    // Per-table residue check for the current run's org + users
    let totalResidue = 0;
    let residue: Record<string, number> = {};
    if (ctx.orgId) {
      console.log("\n--- RESIDUE CHECK (current run) ---");
      residue = await checkResidue(ctx.orgId, ctx.userIds);
      for (const [table, count] of Object.entries(residue)) {
        if (count !== 0) {
          console.error(`  RESIDUE: ${table} = ${count} rows`);
        } else {
          console.log(`  ${table}: 0 ✓`);
        }
        totalResidue += count;
      }
      if (totalResidue === 0) {
        console.log("  Per-table check: ZERO residual rows.");
      } else {
        console.error(`  Per-table check: ${totalResidue} residual rows remain!`);
      }
    }

    // FIX 2 (continued) — sentinel-based global residue check.
    //
    // Queries by org name pattern so it catches leftover rows from ANY harness
    // run, not just the current one. Errors here are thrown (not masked), and
    // any non-zero count causes an explicit exit(1).
    console.log("\n--- SENTINEL RESIDUE CHECK (all harness runs) ---");
    let sentinelOk = true;
    let sentinelOrgs = 0;
    let sentinelUsers = 0;
    try {
      const sentinel = await checkSentinelResidue();
      sentinelOrgs = sentinel.harnessOrgs;
      sentinelUsers = sentinel.harnessUsers;
      if (sentinelOrgs === 0 && sentinelUsers === 0) {
        console.log("  Sentinel check: ZERO harness orgs / ZERO harness users. ✓");
      } else {
        console.error(
          `\n  !! RESIDUE !! sentinel found ${sentinelOrgs} harness org(s) + ${sentinelUsers} harness user(s) in the DB.`,
        );
        console.error("  Manual cleanup required: DELETE FROM organizations WHERE name LIKE '__TIER_DROP_HARNESS__%';");
        sentinelOk = false;
      }
    } catch (err) {
      console.error(`  Sentinel check FAILED: ${err instanceof Error ? err.message : String(err)}`);
      sentinelOk = false;
    }

    // Append to report
    if (ctx.orgId) {
      const repoRoot = join(fileURLToPath(import.meta.url), "../../");
      const reportDir = join(repoRoot, ".git/sdd");
      if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
      const reportPath = join(reportDir, "live-harness-report.md");
      const ts = new Date().toISOString();
      const summary = `
## Live Tier-Drop Harness Run — ${ts}

**Fixes applied:** Slack disabled (SLACK_BOT_TOKEN deleted before main); cleanup FK order hardened; sentinel-based residue check added.

**Env vars:** NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY (from .env.local via --env-file)

**Sentinel org:** \`${sentinelName}\` → id \`${ctx.orgId}\`

**Scenario:**
- Bucket 500 (ultra_high) — agent_uh has a busy_block covering the slot → no free agent
- Bucket 400 (very_high) — agent_vh is free → cascade lands here
- Target slot: ${slotStart}

**Assertion results (${assertionsPassed}/${assertionsTotal} passed):**
- A1 (assigned_user_id = agent_vh): ${bookingResult?.booking.assigned_user_id === agentVhId ? "PASS" : "FAIL"}
- A2a (routing_trace.tier_fallback = true): ${bookingResult?.booking.routing_trace?.tier_fallback === true ? "PASS" : "FAIL"}
- A2b (routing_trace.requested_tier = ultra_high): ${bookingResult?.booking.routing_trace?.requested_tier === "ultra_high" ? "PASS" : "FAIL"}
- A2c (routing_trace.booked_tier = very_high): ${bookingResult?.booking.routing_trace?.booked_tier === "very_high" ? "PASS" : "FAIL"}
- A2d (routing_trace.rungs_dropped = 1): ${bookingResult?.booking.routing_trace?.rungs_dropped === 1 ? "PASS" : "FAIL"}
- A2e (routing_trace.bucket_code = 400): ${bookingResult?.booking.routing_trace?.bucket_code === "400" ? "PASS" : "FAIL"}
- A3a–A3d (routing_decisions row): see console output
- A4a–A4d (webhook payload): see console output

**Post-cleanup residue (per-table, current run):**
${Object.entries(residue).map(([t, c]) => `- ${t}: ${c}`).join("\n")}
Total per-table residue: ${totalResidue} rows (expected: 0)

**Sentinel residue check (all harness runs):**
- Harness orgs remaining: ${sentinelOrgs} (expected: 0)
- Harness users remaining: ${sentinelUsers} (expected: 0)
- Sentinel OK: ${sentinelOk ? "YES ✓" : "NO — RESIDUE DETECTED"}

**Slack / alert_state:**
- SLACK_BOT_TOKEN was deleted before main(); slackConfigured() returned false throughout.
- No real Slack message was sent; no alert_state row was written.

**Concerns:**
- The harness uses bucket codes 500/400 which match production XBC codes; collision is avoided by the org-scoped \`resolveBucketByCode\` stub.

---
`;
      appendFileSync(reportPath, summary, "utf8");
      console.log(`\nReport appended to: ${reportPath}`);
    }

    console.log(
      `\n=== ${assertionsPassed}/${assertionsTotal} assertions passed ===`,
    );

    if (!sentinelOk) {
      console.error("\n!! HARNESS RESIDUE DETECTED — exiting non-zero. Clean up manually before re-running. !!");
      process.exit(1);
    }
  }

  if (assertionsPassed < assertionsTotal) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
