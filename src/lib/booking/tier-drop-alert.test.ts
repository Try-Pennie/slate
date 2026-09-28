import { describe, it, expect, vi, beforeEach } from "vitest";

// Asserts that a tier-drop booking dispatches a throttled Slack alert via
// sendThrottledAlert (key "tier_fallback:<requestedCode>"). sendThrottledAlert
// is a direct import in orchestration.ts, so vi.mock intercepts it.
// Supabase is mocked to prevent real DB calls; supabaseAdmin() throwing is
// caught by the best-effort wrappers (resolveBucketPool, recordRoutingDecision).

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(
    async (_key: string, _cooldownMs: number, _text: string) => {},
  ),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);

// Supabase throws → caught by try/catch in resolveBucketPool &
// recordRoutingDecision; test flow continues to sendThrottledAlert.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("supabase not configured in test");
  },
}));

import {
  createBooking,
  RaceLostRefusalError,
  type BookingDeps,
  type CreateBookingInput,
} from "./orchestration";
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

// No email/phone/salesforceId → no stable key → synthesized key + reservation path (#666)
const tierDropInput: CreateBookingInput = {
  bucketCode: "511",
  startIso: "2026-06-08T13:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Test User" },
  prefill: {},
};

// ---- dep builder -------------------------------------------------------------

const bucketFor = (code: string) => ({ ...bucket511, id: `bkt${code}`, code }) as unknown as Bucket;

// #2843: an Ultra High or Very High cascade is counted daily rather than alerted per
// booking, so the dispatch test cascades a HIGH lead (311 to 211), which still alerts.
function makeTierDropDeps(requested = "511", lower = "411"): BookingDeps {
  const noop = async (..._args: unknown[]): Promise<void> => {};
  return {
    // #2638: no test here routes a booker confirm on a missing code.
    readLeadXbc: async () => {
      throw new Error("Salesforce is not reachable from this test");
    },
    resolveBucketByCode: async (code) => {
      if (code === "511" && requested === "511") return { bucket: bucket511, eventType };
      if (code === "411" && lower === "411") return { bucket: bucket411, eventType };
      if (code === requested || code === lower) return { bucket: bucketFor(code), eventType };
      return null;
    },
    // Empty pool on "511" → NoEligibleAgentsError → cascade to "411"
    // #1300: memberCount 0 is what makes an empty pool page. A bucket with people
    // who are merely off shift returns zero candidates with a NON-zero count and
    // must NOT cascade as a misconfiguration.
    roundRobinCandidates: async (bucket) =>
      bucket.code === requested
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
    loadPastBookingsToComplete: async () => [],
    emitWebhook: noop,
    newManageToken: () => "tok-fixed",
    newIdempotencyKey: () => "anon-fixed",
    appBaseUrl: () => "https://slate.test",
    invalidateSlots: noop,
    recordRoutingDecision: noop,
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
  };
}

// ---- tests -------------------------------------------------------------------

beforeEach(() => vi.clearAllMocks());

describe("tier-drop alert dispatch", () => {
  it("dispatches sendThrottledAlert with key 'tier_fallback:<requestedCode>' on a cascade booking", async () => {
    const deps = makeTierDropDeps("311", "211");

    await createBooking({ ...tierDropInput, bucketCode: "311" }, deps);

    // Exactly one sendThrottledAlert call from the tier-drop path.
    const calls = dispatch.sendThrottledAlert.mock.calls;
    const tierDropCall = calls.find(([key]) =>
      typeof key === "string" && key.startsWith("tier_fallback:"),
    );
    expect(tierDropCall).toBeDefined();
    const [key, cooldownMs, text] = tierDropCall!;
    expect(key).toBe("tier_fallback:311");
    expect(typeof cooldownMs).toBe("number");
    expect(typeof text).toBe("string");
  });

  // #2843: the same cascade one tier up is the routing rule working, counted once a
  // day on the info channel. Both directions in one fixture shape (L159): the test
  // above proves this path DOES dispatch for a High lead.
  it("does NOT dispatch a tier_fallback alert when an Ultra High lead cascades", async () => {
    const deps = makeTierDropDeps();

    const res = await createBooking(tierDropInput, deps);

    expect(res.booking.routing_trace?.tier_fallback).toBe(true);
    const tierDropCalls = dispatch.sendThrottledAlert.mock.calls.filter(([key]) =>
      typeof key === "string" && key.startsWith("tier_fallback"),
    );
    expect(tierDropCalls).toHaveLength(0);
  });

  it("does NOT dispatch a tier_fallback alert when the requested bucket itself has an agent free", async () => {
    const deps = makeTierDropDeps();
    // Override: "511" has a free agent → no cascade
    deps.roundRobinCandidates = async () => ({ candidates: ["a"], memberCount: 1});

    await createBooking(tierDropInput, deps);

    const tierDropCalls = dispatch.sendThrottledAlert.mock.calls.filter(([key]) =>
      typeof key === "string" && key.startsWith("tier_fallback:"),
    );
    expect(tierDropCalls).toHaveLength(0);
  });
});

// #2838: the same dispatch seam, on the confirm path's OTHER page. A lead refused
// after every advisor it was handed lost the overlap race is paged the moment it
// happens, because the daily whisper cannot page one event without either holding
// a second day's page back or re-paging the same lead all day. It lives here
// because this file already owns a full BookingDeps fake behind the mocked
// dispatcher; the refusal is driven by making every insert lose the race.
describe("race bound hit page dispatch (#2838)", () => {
  function racingDeps(candidates: string[], isTest = false): BookingDeps {
    const deps = makeTierDropDeps("411", "311");
    const b = { ...bucket411, is_test: isTest } as unknown as Bucket;
    deps.resolveBucketByCode = async (code) => (code === "411" ? { bucket: b, eventType } : null);
    deps.roundRobinCandidates = async () => ({ candidates, memberCount: candidates.length });
    deps.loadEmails = async (ids) => new Map(ids.map((id) => [id, `${id}@x.com`]));
    // Every insert loses the overlap race to another confirm.
    deps.insertBooking = async () => ({ ok: false as const, conflict: true as const });
    return deps;
  }
  const input411: CreateBookingInput = { ...tierDropInput, bucketCode: "411", allowTestBuckets: true };
  const boundPages = () =>
    dispatch.sendThrottledAlert.mock.calls.filter(([key]) => key === "booking_race_bound_hit");

  it("pages once when the lead is refused at the reassign bound", async () => {
    const err = await createBooking(input411, racingDeps(["a", "b", "c", "d", "e"])).catch((e) => e);
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect((err as RaceLostRefusalError).boundHit).toBe(true);
    expect(boundPages()).toHaveLength(1);
    const [, cooldownMs, text] = boundPages()[0];
    expect(cooldownMs).toBeGreaterThan(0);
    expect(text).toContain("bucket 411");
    expect(text).toContain("4 advisors");
  });

  it("still refuses the lead when the page itself cannot be sent", async () => {
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    const err = await createBooking(input411, racingDeps(["a", "b", "c", "d", "e"])).catch((e) => e);
    // The refusal is the lead's answer; a failed page must not turn it into a 500.
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect(boundPages()).toHaveLength(1);
  });

  it("does not page a refusal below the bound, which the daily whisper counts instead", async () => {
    const err = await createBooking(input411, racingDeps(["a"])).catch((e) => e);
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect((err as RaceLostRefusalError).boundHit).toBe(false);
    expect(boundPages()).toHaveLength(0);
  });

  it("does not page the smoke canary's buckets", async () => {
    const err = await createBooking(input411, racingDeps(["a", "b", "c", "d", "e"], true)).catch((e) => e);
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect(boundPages()).toHaveLength(0);
  });
});

