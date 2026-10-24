import { describe, it, expect, vi, beforeEach } from "vitest";

// #969: a reassign is an internal agent swap; the customer's time is unchanged.
// Today it emails the lead TWICE (a cancellation for the old agent + a fresh
// invite for the new one). Target: exactly ONE notification, the new invite,
// carrying a warm explanation, and the OLD event removed SILENTLY (no separate
// cancellation email). This drives orchestration.reassignBooking against fake
// deps and asserts both: the new event's description explains the swap, and the
// old event's delete suppresses the attendee notification.

vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("supabase not configured in test");
  },
}));

import { reassignBooking, type BookingDeps } from "./orchestration";
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

const bucket = {
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

const targetAgent = {
  id: "target",
  name: "Agent Target",
  email: "target@x.com",
  bookable: true,
  attributes: {},
} as unknown as User;

const booking = {
  id: "bk-1",
  org_id: "org1",
  assigned_user_id: "old",
  agent_name: "Agent Old",
  agent_email: "old@x.com",
  status: "confirmed",
  starts_at: "2026-07-01T15:00:00.000Z",
  ends_at: "2026-07-01T15:30:00.000Z",
  timezone: "America/New_York",
  attendee_name: "Dana Lee",
  attendee_email: "dana@example.com",
  manage_token: "tok-1",
  gcal_event_id: "old-evt",
  routing_trace: null,
} as unknown as Booking;

const REASON = { code: "coverage", detail: null } as unknown as Parameters<
  typeof reassignBooking
>[2];

const createEvent = vi.fn(
  (_email: string, _args: { description?: string }, _clientId?: string): Promise<string> =>
    Promise.resolve("new-evt"),
);
const deleteEvent = vi.fn(
  (_email: string, _eventId: string, _opts?: { notifyAttendee?: boolean }): Promise<void> =>
    Promise.resolve(),
);

function makeDeps(): BookingDeps {
  const noop = async (..._args: unknown[]): Promise<void> => {};
  return {
    // #2638: no test here routes a booker confirm on a missing code.
    readLeadXbc: async () => {
      throw new Error("Salesforce is not reachable from this test");
    },
    // #3246: nor on a submission id.
    readSubmissionLead: async () => {
      throw new Error("Salesforce is not reachable from this test");
    },
    // #1334: nor does any correct a lead's number.
    readCallingNumber: async () => {
      throw new Error("Salesforce is not reachable from this test");
    },
    readEventDescription: async () => {
      throw new Error("no test here edits an invite's description");
    },
    resolveBucketByCode: async () => ({ bucket, eventType }),
    roundRobinCandidates: async () => ["target"],
    busyIntervalsForAgent: async () => [],
    agentActiveBookingStartsMs: async () => [],
    agentWorkingHours: async () => ({ timezone: "America/New_York", rules: [] }),
    verifyFree: async (emails: string[]) => ({ free: new Set(emails), unverified: new Set<string>() }),
    createEvent,
    deleteEvent,
    eventExists: async () => true,
    enqueueEventDeletion: noop,
    loadPendingEventDeletions: async () => [],
    loadCreationOrphans: async () => [],
    liveBookingHoldingEvent: async () => null,
    pendingWritePinsEvent: async () => false,
    removePendingEventDeletion: noop,
    bumpPendingEventDeletion: noop,
    updateEventTime: noop,
    getUser: async () => targetAgent,
    loadEmails: async (ids: string[]) => new Map(ids.map((id) => [id, "target@x.com"])),
    findBookingByIdempotencyKey: async () => null,
    findLatestBookingByIdempotencyKey: async () => null,
    // A reassign never makes a fresh booking, so these refuse loudly rather than letting
    // a cast hide that the fake has no answer for them.
    readBookingByIdempotencyKey: async () => null,
    newBookingId: () => {
      throw new Error("a reassign never mints a fresh booking id");
    },
    commitFreshBooking: async () => {
      throw new Error("a reassign never commits a fresh booking");
    },
    insertBusyBlocks: noop,
    moveBusyBlock: noop,
    reassignSwap: async () => ({ prevGcalEventId: "old-evt", prevAgentEmail: "old@x.com", updated: true }),
    deleteBusyBlocksForBooking: noop,
    deleteGcalMirrorBlock: noop,
    loadReconcilableBusyBlocks: async () => [] as Pick<BusyBlock, "id" | "user_id" | "booking_id" | "source" | "ooo_request_id">[],
    loadBookingStatuses: async () => new Map<string, BookingStatus>(),
    loadInflightCancelBookingIds: async () => new Set<string>(),
    loadJustCancelledBookingIds: async () => new Set<string>(),
    loadApprovedOooRequestIds: async () => new Set<string>(),
    deleteBusyBlocksByIds: async () => [],
    loadActiveUpcomingBookings: async () => [],
    loadBusyBlockBookingIds: async () => new Set<string>(),
    enqueueOutbox: async () => "ob-1",
    loadDrainableOutbox: async () => [] as BookingOutbox[],
    // #1048: the lease is a token, and the writes it guards report their outcome.
    leaseOutbox: async () => "lease-tok",
    saveOutboxSteps: async () => "written" as const,
    markOutboxDelivered: async () => "written" as const,
    releaseOutboxLease: noop,
    bumpOutboxAttempt: noop,
    insertReservation: async (row: Record<string, unknown>) => ({
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
    deleteReservation: async () => "deleted" as const,
    repinReservationEvent: noop,
    loadDrainableReservations: async () => [] as BookingReservation[],
    leaseReservation: async () => "lease-1",
    releaseReservationLease: noop,
    bumpReservationAttempt: noop,
    deleteExpiredReservations: async () => ({ deleted: 0, owed: [] }),
    commitReschedule: async () => true,
    claimCancellation: async () => true,
    completeBookingsIfDue: async () => [] as string[],
    claimReschedule: async () => ({ outcome: "won" as const }),
    writeReschedulePin: noop,
    readReschedulePin: async () => null,
    releaseReschedule: noop,
    releaseRescheduleIfTarget: noop,
    loadAbandonedReschedulePins: async () => [],
    takeOverAbandonedReschedulePin: async () => null,
    releaseAbandonedReschedulePin: async () => {},
    readBookingInviteState: async () => null,
    readEventOnPrimary: async () => null,
    writeReassignIntent: noop,
    deleteReassignIntent: noop,
    loadAbandonedReassignIntents: async () => [],
    insertBookingEvent: async () => "evt-1",
    hasBookingEvent: async () => false,
    getBookingEventId: async () => null,
    loadBookingContext: async () => null,
    loadBookingById: async () => ({ booking, bucket, eventType }),
    findActiveBookingsForPerson: async () => [] as Booking[],
    findActiveBookingsByStrongIds: async () => [] as Booking[],
    queryBookings: async () => ({ rows: [] as Booking[], buckets: [] as Bucket[] }),
    getAgentByEmail: async () => targetAgent,
    loadPastBookingIdsToComplete: async () => [],
    emitWebhook: noop,
    newManageToken: () => "tok-fixed",
    newIdempotencyKey: () => "anon-fixed",
    appBaseUrl: () => "https://slate.test",
    invalidateSlots: noop,
    recordRoutingDecision: noop,
  } as unknown as BookingDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  createEvent.mockResolvedValue("new-evt");
  deleteEvent.mockResolvedValue(undefined);
});

describe("reassign customer notifications (#969)", () => {
  it("creates the new agent's event with an explanation of the swap", async () => {
    await reassignBooking("bk-1", "target@x.com", REASON, makeDeps());

    expect(createEvent).toHaveBeenCalled();
    const args = createEvent.mock.calls[0]?.[1] as { description?: string };
    expect(typeof args.description).toBe("string");
    // Warm, plain explanation: time unchanged + a different advisor.
    expect(args.description ?? "").toMatch(/time.*(has not|hasn't) changed|unchanged/i);
    expect(args.description ?? "").toMatch(/advisor|specialist|agent/i);
  });

  it("removes the old agent's event SILENTLY (no cancellation email to the lead)", async () => {
    await reassignBooking("bk-1", "target@x.com", REASON, makeDeps());

    const oldDelete = deleteEvent.mock.calls.find((c) => c[1] === "old-evt");
    expect(oldDelete).toBeDefined();
    // Third arg carries the suppression flag so Google sends no cancellation.
    expect(oldDelete?.[2]).toMatchObject({ notifyAttendee: false });
  });
});
