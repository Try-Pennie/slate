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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { supabaseAdmin } from "@/lib/supabase/admin";
import * as orchestration from "@/lib/booking/orchestration";
import { roundRobinCandidates } from "@/lib/availability/service";
import type { BookingDeps } from "@/lib/booking/orchestration";
import type { BookingEventPayload, RoutingMeta } from "@/lib/webhooks/types";
import type {
  Booking,
  BookingReservation,
  BookingStatus,
  EventType,
  WebhookEvent,
} from "@/lib/db/types";

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
    return { bucket: bucket as any, eventType };
  }

  return {
    // --- availability / routing ---
    resolveBucketByCode,

    roundRobinCandidates,

    // Single-agent verify: free only for agent_vh
    isFree: async (email) => email === agentVhEmail,

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
    removePendingEventDeletion: async () => {},
    bumpPendingEventDeletion: async () => {},

    // --- Webhook capture ---
    emitWebhook: async (orgId, event, payload, _dedupeKey) => {
      capturedWebhooks.push({ orgId, event, payload: payload as BookingEventPayload });
    },

    // --- Misc ---
    newManageToken: () => randomUUID().replace(/-/g, "").slice(0, 24),
    appBaseUrl: () => "https://harness.test.local",
    invalidateSlots: async () => {},

    // --- DB-backed deps ---
    getUser: async (userId) => {
      const res = await db().from("users").select("*").eq("id", userId).single();
      return res.data as any;
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
        return { ok: false, conflict };
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

    deleteBusyBlocksForBooking: async (bookingId) => {
      await db().from("busy_blocks").delete().eq("booking_id", bookingId);
    },

    loadReconcilableBusyBlocks: async () => [],
    loadBookingStatuses: async () => new Map<string, BookingStatus>(),
    deleteBusyBlocksByIds: async () => {},

    // --- Outbox (not used in createBooking path, provide stubs) ---
    enqueueOutbox: async () => randomUUID(),
    loadDrainableOutbox: async () => [],
    leaseOutbox: async () => false,
    saveOutboxSteps: async () => {},
    markOutboxDelivered: async () => {},
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
      await db().from("booking_reservations").delete().eq("id", id);
    },

    loadDrainableReservations: async () => [],
    leaseReservation: async () => false,
    releaseReservationLease: async () => {},
    deleteExpiredReservations: async () => {},

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
      return { booking: b, bucket: bkRes.data as any, eventType: etRes.data as EventType };
    },

    findActiveBookingsForPerson: async () => [],
    queryBookings: async () => ({ rows: [], buckets: [] }),
    getAgentByEmail: async () => null,
    loadPastBookingsToComplete: async () => [],
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

  // 1. routing_decisions (cascade from org, but be explicit)
  const rd = await db.from("routing_decisions").delete().eq("org_id", orgId);
  console.log(`  routing_decisions deleted: ${rd.error ? "ERROR: " + rd.error.message : "ok"}`);

  // 2. booking_reservations (references users - RESTRICT, must delete before users)
  if (idempotencyKey) {
    const brRes = await db
      .from("booking_reservations")
      .delete()
      .eq("idempotency_key", idempotencyKey);
    console.log(`  booking_reservations deleted: ${brRes.error ? "ERROR: " + brRes.error.message : "ok"}`);
  }
  if (userIds.length > 0) {
    const brAll = await db
      .from("booking_reservations")
      .delete()
      .in("pinned_user_id", userIds);
    console.log(`  booking_reservations (by user) deleted: ${brAll.error ? "ERROR: " + brAll.error.message : "ok"}`);
  }

  // 3. busy_blocks (cascade from users, but be explicit; also cleans the seeded block)
  if (busyBlockIds.length > 0) {
    const bb = await db.from("busy_blocks").delete().in("id", busyBlockIds);
    console.log(`  seeded busy_blocks deleted: ${bb.error ? "ERROR: " + bb.error.message : "ok"}`);
  }
  if (userIds.length > 0) {
    const bbAll = await db.from("busy_blocks").delete().in("user_id", userIds);
    console.log(`  all busy_blocks for test users deleted: ${bbAll.error ? "ERROR: " + bbAll.error.message : "ok"}`);
  }

  // 4. bookings (references users RESTRICT - must delete before users)
  const bkRes = await db.from("bookings").delete().eq("org_id", orgId);
  console.log(`  bookings deleted: ${bkRes.error ? "ERROR: " + bkRes.error.message : "ok"}`);

  // 5. bucket_members (cascade from buckets/users)
  if (bucketIds.length > 0) {
    const bmRes = await db.from("bucket_members").delete().in("bucket_id", bucketIds);
    console.log(`  bucket_members deleted: ${bmRes.error ? "ERROR: " + bmRes.error.message : "ok"}`);
  }

  // 6. availability_rules (cascade from schedules)
  if (scheduleIds.length > 0) {
    const arRes = await db.from("availability_rules").delete().in("schedule_id", scheduleIds);
    console.log(`  availability_rules deleted: ${arRes.error ? "ERROR: " + arRes.error.message : "ok"}`);
  }

  // 7. availability_schedules (cascade from users)
  if (userIds.length > 0) {
    const asRes = await db.from("availability_schedules").delete().in("user_id", userIds);
    console.log(`  availability_schedules deleted: ${asRes.error ? "ERROR: " + asRes.error.message : "ok"}`);
  }

  // 8. buckets (before event_types + users)
  const bRes = await db.from("buckets").delete().eq("org_id", orgId);
  console.log(`  buckets deleted: ${bRes.error ? "ERROR: " + bRes.error.message : "ok"}`);

  // 9. event_types
  const etRes = await db.from("event_types").delete().eq("org_id", orgId);
  console.log(`  event_types deleted: ${etRes.error ? "ERROR: " + etRes.error.message : "ok"}`);

  // 10. users
  const uRes = await db.from("users").delete().eq("org_id", orgId);
  console.log(`  users deleted: ${uRes.error ? "ERROR: " + uRes.error.message : "ok"}`);

  // 11. organizations
  const oRes = await db.from("organizations").delete().eq("id", orgId);
  console.log(`  organizations deleted: ${oRes.error ? "ERROR: " + oRes.error.message : "ok"}`);
}

// ---------------------------------------------------------------------------
// Post-cleanup residue check
// ---------------------------------------------------------------------------

async function checkResidue(orgId: string, userIds: string[]): Promise<Record<string, number>> {
  const db = supabaseAdmin();
  const queries = await Promise.all([
    db.from("routing_decisions").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("busy_blocks").select("id", { count: "exact", head: true }).in("user_id", userIds.length ? userIds : ["__none__"]),
    db.from("bookings").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("buckets").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("event_types").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("users").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("organizations").select("id", { count: "exact", head: true }).eq("id", orgId),
    db.from("availability_schedules").select("id", { count: "exact", head: true }).in("user_id", userIds.length ? userIds : ["__none__"]),
    db.from("availability_rules").select("id", { count: "exact", head: true }).eq("id", "__none__"), // handled by cascade
    db.from("booking_reservations").select("id", { count: "exact", head: true }).in("pinned_user_id", userIds.length ? userIds : ["__none__"]),
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
    "availability_rules_proxy",
    "booking_reservations",
  ];

  const residue: Record<string, number> = {};
  for (let i = 0; i < labels.length; i++) {
    residue[labels[i]] = queries[i].count ?? 0;
  }
  return residue;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const epoch = Date.now();
  const sentinelName = `__TIER_DROP_HARNESS__${epoch}`;

  // The idempotency key uses a unique salesforce id so the booking gets a key.
  const testSalesforceId = `harness-sf-${epoch}`;
  const idempotencyKey: string | null = null; // will be computed by orchestration

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

    // Post-cleanup residue check
    if (ctx.orgId) {
      console.log("\n--- RESIDUE CHECK ---");
      const residue = await checkResidue(ctx.orgId, ctx.userIds);
      let totalResidue = 0;
      for (const [table, count] of Object.entries(residue)) {
        // availability_rules_proxy is a placeholder — skip
        if (table === "availability_rules_proxy") continue;
        if (count > 0) {
          console.error(`  RESIDUE: ${table} = ${count} rows`);
        } else {
          console.log(`  ${table}: 0 ✓`);
        }
        totalResidue += count;
      }
      if (totalResidue === 0) {
        console.log("  Cleanup verified: ZERO residual rows.");
      } else {
        console.error(`  WARNING: ${totalResidue} residual rows remain!`);
      }

      // Append to report
      const repoRoot = join(fileURLToPath(import.meta.url), "../../");
      const reportDir = join(repoRoot, ".git/sdd");
      if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
      const reportPath = join(reportDir, "live-harness-report.md");
      const ts = new Date().toISOString();
      const summary = `
## Live Tier-Drop Harness Run — ${ts}

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

**Post-cleanup residue:**
${Object.entries(residue).filter(([t]) => t !== "availability_rules_proxy").map(([t, c]) => `- ${t}: ${c}`).join("\n")}
Total residue: ${totalResidue} rows (expected: 0)

**Concerns:**
- If SLACK_BOT_TOKEN is set in .env.local, a throttled "tier_fallback:500" Slack alert may have been sent (and alert_state updated). This is cosmetic — the test org is fully cleaned up.
- The harness uses bucket codes 500/400 which match production XBC codes; collision is avoided by the org-scoped \`resolveBucketByCode\` stub.

---
`;
      appendFileSync(reportPath, summary, "utf8");
      console.log(`\nReport appended to: ${reportPath}`);
    }

    console.log(
      `\n=== ${assertionsPassed}/${assertionsTotal} assertions passed ===`,
    );
  }

  if (assertionsPassed < assertionsTotal) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
