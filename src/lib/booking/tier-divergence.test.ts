import { describe, it, expect, vi, beforeEach } from "vitest";

// Asserts the runtime half of AUD-061 (#827): on a fresh confirm, when the tier
// the availability cache currently DISPLAYS for the requested bucket differs from
// the tier the booking actually landed on (verify-on-book dropped a further rung
// between display and confirm), createBooking emits ONE structured log line
// tagged "tier-divergence". It is a measure, not an alert. Same divergence, no
// line. Displayed-tier read failing (null) => no line, so smoke/test buckets
// (which resolve to null) never pollute the measure.

const logMock = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  formatLine: () => "",
}));
vi.mock("@/lib/log", () => logMock);

// Supabase throws → caught by try/catch in resolveBucketPool &
// recordRoutingDecision; test flow continues.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("supabase not configured in test");
  },
}));

import {
  createBooking,
  type BookingDeps,
  type CreateBookingInput,
} from "./orchestration";
import { tierKeyOf } from "@/lib/routing/tiers";
import type {
  Booking,
  BookingOutbox,
  BookingReservation,
  Bucket,
  BusyBlock,
  BookingStatus,
  EventType,
  User,
} from "@/lib/db/types";

// ---- fixtures ----------------------------------------------------------------

const bucket511 = {
  id: "bkt511",
  org_id: "org1",
  code: "511",
  is_test: false,
  criteria: {},
  fallback_user_id: null,
} as unknown as Bucket;

const bucket411 = {
  id: "bkt411",
  org_id: "org1",
  code: "411",
  is_test: false,
  criteria: {},
  fallback_user_id: null,
} as unknown as Bucket;

const eventType = {
  id: "et1",
  name: "Senior Call",
  regal_type: "call",
  description: "desc",
  duration_min: 30,
  min_notice_min: 0,
  daily_cap: null,
  buffer_before_min: 0,
  buffer_after_min: 0,
  slot_interval_min: 30,
} as unknown as EventType;

const agentA: User = {
  id: "a",
  name: "Agent A",
  email: "a@x.com",
  attributes: {},
} as unknown as User;

// Keyless → synthesized key + reservation path (#666).
const bookInput: CreateBookingInput = {
  bucketCode: "511",
  startIso: "2026-06-08T13:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Test User" },
  prefill: {},
};

// ---- dep builder -------------------------------------------------------------

function makeDeps(): BookingDeps {
  const noop = async (..._args: unknown[]): Promise<void> => {};
  return {
    // #2638: no test here routes a booker confirm on a missing code.
    readLeadXbc: async () => {
      throw new Error("Salesforce is not reachable from this test");
    },
    resolveBucketByCode: async (code) => {
      if (code === "511") return { bucket: bucket511, eventType };
      if (code === "411") return { bucket: bucket411, eventType };
      return null;
    },
    // Empty pool on "511" → NoEligibleAgentsError → cascade to "411".
    // #1300: memberCount 0 is what makes an empty pool page. A bucket with people
    // who are merely off shift returns zero candidates with a NON-zero count and
    // must NOT cascade as a misconfiguration.
    roundRobinCandidates: async (bucket) =>
      bucket.code === "511"
        ? { candidates: [], memberCount: 0}
        : { candidates: ["a"], memberCount: 1},
    // Gate 1 (#1295) open all week, so these stay about the tier cascade.
    businessHours: async () => ({
      zone: "America/New_York",
      rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
      exceptions: [],
    }),
    busyIntervalsForAgent: async () => [],
    agentActiveBookingStartsMs: async () => [],
    agentWorkingHours: async () => ({ timezone: "America/New_York", rules: [] }),
    verifyFree: async (emails) => ({
      free: new Set(emails),
      unverified: new Set<string>(),
    }),
    createEvent: async () => "gcal-1",
    deleteEvent: noop,
    eventExists: async () => true,
    enqueueEventDeletion: noop,
    loadPendingEventDeletions: async () => [],
    loadCreationOrphans: async () => [],
    removePendingEventDeletion: noop,
    bumpPendingEventDeletion: noop,
    updateEventTime: noop,
    updateEventDescription: noop,
    updateEventContact: noop,
    updateBookingContact: noop,
    updateBookingPhone: noop,
    getUser: async () => agentA,
    loadEmails: async (ids) => new Map(ids.map((id) => [id, "a@x.com"])),
    findBookingByIdempotencyKey: async () => null,
    insertBooking: async (row) => ({
      ok: true as const,
      booking: { ...row, id: "bk-new" } as unknown as Booking,
    }),
    insertBusyBlocks: noop,
    moveBusyBlock: noop,
    reassignSwap: async () => ({ prevGcalEventId: null, prevAgentEmail: null, updated: true }),
    deleteBusyBlocksForBooking: noop,
    deleteGcalMirrorBlock: noop,
    loadReconcilableBusyBlocks: async () =>
      [] as Pick<BusyBlock, "id" | "user_id" | "booking_id" | "source" | "ooo_request_id">[],
    loadBookingStatuses: async () => new Map<string, BookingStatus>(),
    loadInflightCancelBookingIds: async () => new Set<string>(),
    loadApprovedOooRequestIds: async () => new Set<string>(),
    deleteBusyBlocksByIds: noop,
    loadActiveUpcomingBookings: async () => [],
    loadBusyBlockBookingIds: async () => new Set<string>(),
    enqueueOutbox: async () => "ob-1",
    loadDrainableOutbox: async () => [] as BookingOutbox[],
    // #1048: the lease is a TOKEN now, and every write on the row is gated on it.
    leaseOutbox: async () => "lease-tok",
    saveOutboxSteps: async () => "written" as const,
    markOutboxDelivered: async () => "written" as const,
    releaseOutboxLease: noop,
    bumpOutboxAttempt: noop,
    insertReservation: async (row) => ({
      id: "resv-1",
      ...row,
      status: "pending" as const,
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    }),
    loadReservationByKey: async () => null,
    deleteReservation: noop,
    loadDrainableReservations: async () => [] as BookingReservation[],
    leaseReservation: async () => true,
    releaseReservationLease: noop,
    bumpReservationAttempt: noop,
    deleteExpiredReservations: noop,
    commitReschedule: async () => true,
    claimCancellation: async () => true,
    completeBookingsIfDue: async () => [] as string[],
    claimReschedule: async () => ({ outcome: "won" as const }),
    writeReschedulePin: noop,
    readReschedulePin: async () => null,
    releaseReschedule: noop,
    releaseRescheduleIfTarget: noop,
    loadAbandonedReschedulePins: async () => [],
    writeReassignIntent: noop,
    deleteReassignIntent: noop,
    loadAbandonedReassignIntents: async () => [],
    insertBookingEvent: async () => "evt-1",
    hasBookingEvent: async () => false,
    getBookingEventId: async () => null,
    loadBookingContext: async () => null,
    loadBookingById: async () => null,
    findActiveBookingsForPerson: async () => [] as Booking[],
    findActiveBookingsByStrongIds: async () => [],
    loadAgentDisplayName: async () => null,
    queryBookings: async () => ({ rows: [] as Booking[], buckets: [] as Bucket[] }),
    getAgentByEmail: async () => null,
    loadPastBookingIdsToComplete: async () => [],
    emitWebhook: noop,
    newManageToken: () => "tok-fixed",
    newIdempotencyKey: () => "anon-fixed",
    appBaseUrl: () => "https://slate.test",
    invalidateSlots: noop,
    recordRoutingDecision: noop,
    // The currently-displayed tier for a bucket (best-effort). Overridden per test.
    displayedTier: async () => null,
    // #2371: these suites are about the tier ladder, not the owner alert. They are
    // present so `tsc` enumerates every construction site of BookingDeps, and each
    // throws rather than no-oping, so a path that unexpectedly reaches one fails
    // loudly here instead of quietly proving nothing.
    createOwnerAlertEvent: async () => {
      throw new Error("owner alert not exercised by this suite");
    },
    deleteOwnerAlertEvent: noop,
    moveOwnerAlertEvent: noop,
    loadLiveOwnerAlert: async () => null,
    insertOwnerAlert: async () => {
      throw new Error("owner alert not exercised by this suite");
    },
    setOwnerAlertEventId: noop,
    recordOwnerAlertSkip: noop,
    markOwnerAlertRemoved: noop,
    // #2372: the same for the owner reassign notice. A suite about the tier ladder
    // must never post to Slack, so the post throws rather than no-oping.
    loadHandoffChannel: async () => null,
    postHandoffNotice: async () => {
      throw new Error("owner reassign notice not exercised by this suite");
    },
    advisorTimezone: async () => null,
    // #2838: a suite that is not about the race bound must never page, so the
    // dispatcher is never the real one; it throws, which the confirm path logs.
    pageRaceBoundHit: () => {
      throw new Error("race bound hit page not exercised by this suite");
    },
  };
}

// ---- tests -------------------------------------------------------------------

beforeEach(() => vi.clearAllMocks());

describe("tier divergence measure (#827)", () => {
  it("emits one tier-divergence log line when displayed tier differs from booked tier", async () => {
    const deps = makeDeps();
    // Cache still shows the requested (tier-5) bucket, but the booking cascades
    // to 411 (tier-4): a divergence introduced between display and confirm.
    deps.displayedTier = async () => tierKeyOf("511");

    await createBooking(bookInput, deps);

    const calls = logMock.log.info.mock.calls.filter(
      ([tag]) => tag === "tier-divergence",
    );
    expect(calls).toHaveLength(1);
    const [, fields] = calls[0];
    expect(fields.displayed_tier).toBe(tierKeyOf("511"));
    expect(fields.booked_tier).toBe(tierKeyOf("411"));
    expect(fields.bucket).toBe("511");
    expect(fields.booking_id).toBe("bk-new");
  });

  it("emits nothing when the displayed tier equals the booked tier", async () => {
    const deps = makeDeps();
    // No cascade (511 has a free agent) and the cache shows tier-5 too.
    deps.roundRobinCandidates = async () => ({ candidates: ["a"], memberCount: 1});
    deps.displayedTier = async () => tierKeyOf("511");

    await createBooking(bookInput, deps);

    const calls = logMock.log.info.mock.calls.filter(
      ([tag]) => tag === "tier-divergence",
    );
    expect(calls).toHaveLength(0);
  });

  it("emits nothing when the displayed-tier read returns null (test bucket / read failed)", async () => {
    const deps = makeDeps();
    // Booking still cascades 511 → 411, but the display read yields null.
    deps.displayedTier = async () => null;

    await createBooking(bookInput, deps);

    const calls = logMock.log.info.mock.calls.filter(
      ([tag]) => tag === "tier-divergence",
    );
    expect(calls).toHaveLength(0);
  });
});
