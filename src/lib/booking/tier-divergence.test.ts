import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfirmQueue, isolateLine } from "@/lib/booking/confirm-queue";
import { makeCommitCostLog } from "@/lib/booking/commit-cost";
// #3495: the fresh booking save, modelled over the fake's separate steps.
import { commitFreshModel, type CommitFreshParts } from "../../../scripts/lib/commit-fresh-model";

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

function makeDeps(): BookingDeps & CommitFreshParts {
  const noop = async (..._args: unknown[]): Promise<void> => {};
  return {
    // #3272: the pool read is injected now; these tests never reach it with a
    // pool to report, so it fails like the Supabase read it stood in for.
    resolveBucketPool: async () => {
      throw new Error("no pool read in this test");
    },
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
    loadPendingEventDeletionsForCalendar: async () => [],
    loadCalendarOwners: async () => [],
    loadBookingAssignees: async () => [],
    loadCreationOrphans: async () => [],
    liveBookingHoldingEvent: async () => null,
    pendingWritePinsEvent: async () => false,
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
    findLatestBookingByIdempotencyKey: async () => null,
    readBookingByIdempotencyKey: async () => null,
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
    loadStillActiveBookingIds: async (ids: string[]) => new Set<string>(ids),
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
    deleteReservation: async () => "deleted" as const,
    repinReservationEvent: noop,
    loadDrainableReservations: async () => [] as BookingReservation[],
    leaseReservation: async () => "lease-1",
    releaseReservationLease: noop,
    bumpReservationAttempt: noop,
    deleteExpiredReservations: async () => ({ deleted: 0, owed: [] }),
    commitReschedule: async () => "ob-1",
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
    loadBookingById: async () => null,
    findActiveBookingsForPerson: async () => [] as Booking[],
    earlierLeadBookings: async () => [],
    findActiveBookingsStartingAt: async () => [] as Booking[],
    findActiveBookingsByStrongIds: async () => [],
    loadAgentDisplayName: async () => null,
    queryBookings: async () => ({ rows: [] as Booking[], buckets: [] as Bucket[] }),
    getAgentByEmail: async () => null,
    loadPastBookingIdsToComplete: async () => [],
    emitWebhook: noop,
    newManageToken: () => "tok-fixed",
    newBookingId: () => "bk-new",
    commitFreshBooking(this: CommitFreshParts, req) {
      return commitFreshModel(this, req);
    },
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
    ownerReassignNoticeOn: async () => false,
    postHandoffNotice: async () => {
      throw new Error("owner reassign notice not exercised by this suite");
    },
    advisorTimezone: async () => null,
    // #2838: a suite that is not about the race bound must never page, so the
    // dispatcher is never the real one; it throws, which the confirm path logs.
    pageRaceBoundHit: () => {
      throw new Error("race bound hit page not exercised by this suite");
    },
    // #3221: a line of this fake's own, never the isolate's.
    confirmQueue: isolateLine(makeConfirmQueue()),
    commitCosts: makeCommitCostLog(),
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

// 2026-10-02: the tier the booker had on show is SAVED on the booking, not only
// logged, so /admin/routing can tell "the lead's tier had times on show and lost
// the last one at confirm" from "the lead's tier had no times at all". The log
// above is kept 7 days and was the only record before this.
describe("displayed tier on the routing trace", () => {
  it("records the tier on show at confirm beside the tier booked", async () => {
    const deps = makeDeps();
    deps.displayedTier = async () => tierKeyOf("511");

    const res = await createBooking(bookInput, deps);

    expect(res.booking.routing_trace?.displayed_tier).toBe(tierKeyOf("511"));
    expect(res.booking.routing_trace?.booked_tier).toBe(tierKeyOf("411"));
    expect(res.booking.routing_trace?.tier_fallback).toBe(true);
  });

  it("records null, never a guess, when the display read found nothing", async () => {
    const deps = makeDeps();
    deps.displayedTier = async () => null;

    const res = await createBooking(bookInput, deps);

    expect(res.booking.routing_trace?.displayed_tier).toBeNull();
  });

  // #3495: the booker sends the tier it had on show, so the confirm records that and
  // makes no read for it. The read cost a database request per rung walked in a
  // crowd, where every booking had just cleared the cache, and it could see another
  // confirm's booking and file a lost last time as "nothing on show".
  it("records the tier the page sent and does not read the cache for it (#3495)", async () => {
    const deps = makeDeps();
    const read = vi.fn(async () => tierKeyOf("411"));
    deps.displayedTier = read;

    const res = await createBooking({ ...bookInput, shownTier: tierKeyOf("511")! }, deps);

    expect(read).not.toHaveBeenCalled();
    expect(res.booking.routing_trace?.displayed_tier).toBe(tierKeyOf("511"));
  });

  it("reads the cache as before when the page sent no tier: a partner call, or an older page (#3495)", async () => {
    const deps = makeDeps();
    const read = vi.fn(async () => tierKeyOf("511"));
    deps.displayedTier = read;

    const res = await createBooking(bookInput, deps);

    expect(read).toHaveBeenCalledTimes(1);
    expect(res.booking.routing_trace?.displayed_tier).toBe(tierKeyOf("511"));
  });

  it("records null and still books when the display read throws", async () => {
    const deps = makeDeps();
    deps.displayedTier = async () => {
      throw new Error("availability cache unreadable");
    };

    const res = await createBooking(bookInput, deps);

    expect(res.booking.id).toBe("bk-new");
    expect(res.booking.routing_trace?.displayed_tier).toBeNull();
  });
});
