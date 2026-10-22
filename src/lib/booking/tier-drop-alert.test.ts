import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfirmQueue, isolateLine } from "@/lib/booking/confirm-queue";
import { makeCommitCostLog } from "@/lib/booking/commit-cost";
// #3495: the fresh booking save, modelled over the fake's separate steps.
import { commitFreshModel, type CommitFreshParts } from "../../../scripts/lib/commit-fresh-model";

// Asserts which tier-drop bookings dispatch a throttled Slack alert via
// sendThrottledAlert: only a drop of two or more debt tiers does
// (key "tier_fallback_deep:<requestedCode>"); a single tier drop sends nothing. sendThrottledAlert
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

import { log } from "@/lib/log";
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
function makeTierDropDeps(requested = "511", lower = "411"): BookingDeps & CommitFreshParts {
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

beforeEach(() => {
  vi.clearAllMocks();
  // An implementation set by one test (a Slack that never answers, one that throws)
  // must not leak into the next, which clearAllMocks alone does not undo.
  dispatch.sendThrottledAlert.mockImplementation(async () => {});
});

describe("tier-drop alert dispatch", () => {
  it("dispatches 'tier_fallback_deep:<requestedCode>' when a High lead drops two debt tiers", async () => {
    // 211 has no bucket row in this fixture, so the cascade skips it and lands on 111.
    const deps = makeTierDropDeps("311", "111");

    await createBooking({ ...tierDropInput, bucketCode: "311" }, deps);

    const deep = dispatch.sendThrottledAlert.mock.calls.filter(([key]) =>
      typeof key === "string" && key.startsWith("tier_fallback"),
    );
    expect(deep).toHaveLength(1);
    const [key, cooldownMs, text] = deep[0];
    expect(key).toBe("tier_fallback_deep:311");
    expect(typeof cooldownMs).toBe("number");
    expect(text).toMatch(/dropped 2 debt tiers/);
  });

  // #3266: on a lead's request the page goes after their answer, outside the
  // confirm's budget, so a slow Slack can neither hold the answer of a booking that
  // exists nor be refused because the budget was spent. The test above, with no
  // scheduler, is the cron drain's inline send.
  it("on a lead's request, answers without waiting on the page and still sends it after", async () => {
    const deps = makeTierDropDeps("311", "111");
    const deferred: { context: string; send: () => Promise<unknown> }[] = [];
    deps.deferPage = (context, send) => {
      deferred.push({ context, send });
    };
    // A Slack that never answers: awaited in front of the answer, it would hang.
    dispatch.sendThrottledAlert.mockImplementation(() => new Promise(() => {}));

    // Awaited directly: had the answer waited on that page it would never settle
    // and the test would fail on its timeout, with no timer guess about load (L290).
    await createBooking({ ...tierDropInput, bucketCode: "311" }, deps);
    expect(dispatch.sendThrottledAlert.mock.calls.filter(([key]) => String(key).startsWith("tier_fallback"))).toHaveLength(0);

    const page = deferred.filter((d) => d.context === "tier-fallback-page");
    expect(page).toHaveLength(1);
    void page[0].send();
    expect(dispatch.sendThrottledAlert.mock.calls.filter(([key]) => key === "tier_fallback_deep:311")).toHaveLength(1);
  });

  it("a tier page that fails to send after the answer settles, so it is logged rather than escaping", async () => {
    const deps = makeTierDropDeps("311", "111");
    const deferred: (() => Promise<unknown>)[] = [];
    deps.deferPage = (_context, send) => {
      deferred.push(send);
    };
    dispatch.sendThrottledAlert.mockImplementation(async () => {
      throw new Error("slack did not answer");
    });
    const logged = vi.spyOn(log, "error");
    await createBooking({ ...tierDropInput, bucketCode: "311" }, deps);
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(
      "alert-dispatch",
      { msg: "alert send failed", key: "tier_fallback_deep:311" },
      expect.any(Error),
    );
    logged.mockRestore();
  });

  // 2026-10-02: a single tier drop is the ladder working as designed (sales ops:
  // keep the lead's time, drop a tier) and is counted on /admin/routing. The test
  // above is the positive control in the same fixture shape (L159): this path
  // DOES dispatch, just not for one tier.
  it("does NOT dispatch anything when a High lead drops one debt tier", async () => {
    const deps = makeTierDropDeps("311", "211");

    const res = await createBooking({ ...tierDropInput, bucketCode: "311" }, deps);

    expect(res.booking.routing_trace?.tier_fallback).toBe(true);
    expect(res.booking.routing_trace?.bucket_code).toBe("211");
    const tierDropCalls = dispatch.sendThrottledAlert.mock.calls.filter(([key]) =>
      typeof key === "string" && key.startsWith("tier_fallback"),
    );
    expect(tierDropCalls).toHaveLength(0);
  });

  // #2843: the same cascade one tier up is the routing rule working, counted once a
  // day on the info channel. The deep drop test above is the positive control in
  // the same fixture shape (L159).
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

// #2838: a lead refused after every advisor it was handed lost the overlap race is
// paged the moment it happens. The page goes through `deps.pageRaceBoundHit`, so
// this suite hands in a recorder and nothing it drives can reach alert_state or
// Slack (L2); the production dispatcher is tested on its own in
// race-bound-page.test.ts. It lives here because this file already owns a full
// BookingDeps fake; the refusal is driven by making every insert lose the race.
describe("race bound hit page (#2838)", () => {
  function racingDeps(candidates: string[], isTest = false) {
    const pages: { key: string; cooldownMs: number; text: string }[] = [];
    const deps = makeTierDropDeps("411", "311");
    const b = { ...bucket411, is_test: isTest } as unknown as Bucket;
    deps.resolveBucketByCode = async (code) => (code === "411" ? { bucket: b, eventType } : null);
    deps.roundRobinCandidates = async () => ({ candidates, memberCount: candidates.length });
    deps.loadEmails = async (ids) => new Map(ids.map((id) => [id, `${id}@x.com`]));
    // Every insert loses the overlap race to another confirm.
    deps.insertBooking = async () => ({ ok: false as const, conflict: true as const });
    deps.pageRaceBoundHit = (page) => {
      pages.push(page);
    };
    return { deps, pages };
  }
  const input411: CreateBookingInput = { ...tierDropInput, bucketCode: "411", allowTestBuckets: true };

  it("hands the dispatcher one page when the lead is refused at the reassign bound", async () => {
    const { deps, pages } = racingDeps(["a", "b", "c", "d", "e"]);
    const err = await createBooking(input411, deps).catch((e) => e);
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect((err as RaceLostRefusalError).boundHit).toBe(true);
    expect(pages).toHaveLength(1);
    expect(pages[0].key).toBe("booking_race_bound_hit");
    expect(pages[0].cooldownMs).toBeGreaterThan(0);
    expect(pages[0].text).toContain("bucket 411");
    expect(pages[0].text).toContain("4 advisors");
    // Never the real dispatcher.
    expect(dispatch.sendThrottledAlert.mock.calls.filter(([k]) => k === "booking_race_bound_hit")).toHaveLength(0);
  });

  it("does not page a refusal below the bound, which the daily whisper counts instead", async () => {
    const { deps, pages } = racingDeps(["a"]);
    const err = await createBooking(input411, deps).catch((e) => e);
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect((err as RaceLostRefusalError).boundHit).toBe(false);
    expect(pages).toHaveLength(0);
  });

  it("does not page the smoke canary's buckets", async () => {
    const { deps, pages } = racingDeps(["a", "b", "c", "d", "e"], true);
    const err = await createBooking(input411, deps).catch((e) => e);
    expect(err).toBeInstanceOf(RaceLostRefusalError);
    expect(pages).toHaveLength(0);
  });
});
