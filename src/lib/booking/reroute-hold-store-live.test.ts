import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3248: building the hold store's deps must never touch the database client, so a
// missing key or a bad environment fails inside the caller's own catch (the self
// heal lane's sweep boundary, L73) instead of while the deps are being wired.
//
// #3307: on a request path the pool refresh after a place or release runs AFTER the
// response. Awaited, it held Find an advisor for 24 seconds in production (five
// pools at about four seconds each), past the panel's 20 second abort, so a hold
// that had been placed read as "could not reach the server". The refresh here is
// a promise that settles only when a fake clock passes 20 seconds, and nothing in
// these tests waits on real time.

const PLACED = { hold_id: "H1", expires_at: "2031-03-04T10:05:00.000Z", refused: null };

const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    rpc: vi.fn(async (name: string) =>
      name === "place_reroute_hold"
        ? { data: [{ hold_id: "H1", expires_at: "2031-03-04T10:05:00.000Z", refused: null }], error: null }
        : { data: [{ fn: name }], error: null },
    ),
    from: vi.fn(() => ({
      delete: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [{ agent_user_id: "NEW" }], error: null }) }) }) }),
    })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => admin);

/** The shared every minute refresh, made slow: it settles 20 fake seconds after it starts. */
const slot = vi.hoisted(() => ({
  refreshPoolsForAgents: vi.fn(
    (_ids: string[], _label: string) =>
      new Promise((resolve) => setTimeout(() => resolve({ refreshed: 5, deferred: 1, failed: 0, debounced: 0 }), 20_000)),
  ),
}));
vi.mock("@/lib/availability/slot-cache", () => slot);

/** What a route handed to run after its response, in order. */
const after = vi.hoisted(() => ({ jobs: [] as { context: string; work: () => Promise<unknown> }[] }));
vi.mock("@/lib/after-response", () => ({
  afterResponse: vi.fn((context: string, work: () => Promise<unknown>) => {
    after.jobs.push({ context, work });
  }),
}));

import { rerouteHoldStoreDeps } from "./reroute-hold-store-live";
import { placeRerouteHold, releaseRerouteHold } from "./reroute-hold-store";
import { confirmReroute, startReroute, type RerouteDeps } from "./reroute";
import type { Booking, Bucket, EventType } from "../db/types";
import type { RerouteTarget } from "./orchestration";

const ARGS = {
  orgId: "org1", bookingId: "K1", agentUserId: "NEW", requestedBucketId: "b512", targetBucketId: "b512", rungsDropped: 0, createdBy: "admin",
};

/** Whether a promise has settled, read without awaiting it. */
function track<T>(p: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  p.then(
    (v) => {
      state.settled = true;
      state.value = v;
    },
    (e) => {
      state.settled = true;
      state.error = e;
    },
  );
  return state;
}

/** Drain every pending promise without moving the fake clock: "answered promptly". */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  after.jobs.length = 0;
  slot.refreshPoolsForAgents.mockClear();
  admin.supabaseAdmin.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rerouteHoldStoreDeps", () => {
  it("makes no database client until a call is made", async () => {
    const deps = rerouteHoldStoreDeps("test", "inline");
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
    const res = await deps.pruneRpc();
    expect(admin.supabaseAdmin).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual([{ fn: "prune_expired_reroute_hold_blocks" }]);
  });

  it("so a client that cannot be made throws at the call, where the caller catches it", async () => {
    admin.supabaseAdmin.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SECRET_KEY is not set");
    });
    const deps = rerouteHoldStoreDeps("test", "inline");
    expect(() => deps.pruneRpc()).toThrow(/SUPABASE_SECRET_KEY/);
  });
});

describe("the refresh after a place or release (#3307)", () => {
  it("on a request path, a place answers once the hold is saved and the refresh runs after the response", async () => {
    const placed = track(placeRerouteHold(ARGS, rerouteHoldStoreDeps("reroute", "after-response")));
    await flush();
    expect(placed.settled).toBe(true);
    expect(placed.value).toEqual({ placed: true, holdId: PLACED.hold_id, expiresAt: PLACED.expires_at });
    expect(slot.refreshPoolsForAgents).not.toHaveBeenCalled();
    expect(after.jobs).toHaveLength(1);

    // The deferred job is the same shared refresh, for the held advisor, and it
    // runs to the end once the response has gone.
    const ran = track(after.jobs[0]!.work());
    await flush();
    expect(slot.refreshPoolsForAgents).toHaveBeenCalledWith(["NEW"], "reroute");
    expect(ran.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ran.settled).toBe(true);
    expect(ran.error).toBeUndefined();
  });

  it("a release on a request path answers the same way", async () => {
    const released = track(releaseRerouteHold("K1", rerouteHoldStoreDeps("reroute", "after-response")));
    await flush();
    expect(released.value).toEqual({ released: true });
    expect(after.jobs).toHaveLength(1);
    expect(slot.refreshPoolsForAgents).not.toHaveBeenCalled();
  });

  it("CONTROL: inline, as the self heal sweep runs it, the same place waits the whole refresh", async () => {
    // Without this, a test that cannot see a blocked answer would pass the fix and
    // the bug alike (L1).
    const placed = track(placeRerouteHold(ARGS, rerouteHoldStoreDeps("reroute-hold-sweep", "inline")));
    await flush();
    expect(placed.settled).toBe(false);
    expect(after.jobs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(placed.settled).toBe(true);
    expect(slot.refreshPoolsForAgents).toHaveBeenCalledWith(["NEW"], "reroute-hold-sweep");
  });
});

// The routes' own path: the real start and confirm over the real hold store, with
// everything else a fake that answers at once, so the only slow thing is the refresh.
const eventType = { id: "et1", duration_min: 20, buffer_before_min: 10, buffer_after_min: 10 } as unknown as EventType;
const bucketFor = (code: string) => ({ id: `b${code}`, org_id: "org1", code, name: `name ${code}`, is_test: false }) as unknown as Bucket;
const booking = {
  id: "K1", org_id: "org1", assigned_user_id: "CUR", agent_name: "Taylor Brooks", agent_email: "cur@x.com",
  gcal_event_id: "ev-cur", starts_at: "2031-03-04T10:00:00.000Z", ends_at: "2031-03-04T10:20:00.000Z",
  kind: "routed", status: "confirmed",
} as unknown as Booking;
const PEOPLE: Record<string, { name: string; email: string }> = {
  CUR: { name: "Taylor Brooks", email: "cur@x.com" },
  NEW: { name: "Morgan Reyes", email: "new@x.com" },
  NEXT: { name: "Casey Lin", email: "next@x.com" },
};
const moveTo = (userId: string): RerouteTarget => ({
  outcome: "move-in-requested", bucket: bucketFor("512"), eventType, rungsDropped: 0, userId, email: PEOPLE[userId]!.email, candidates: [userId],
});

function routeDeps(o: { targets: RerouteTarget[]; free: string[] }) {
  // Built once per request, as the routes build theirs.
  const holds = rerouteHoldStoreDeps("reroute", "after-response");
  const targets = [...o.targets];
  const deps: RerouteDeps = {
    loadBookingById: async () => ({ booking, bucket: bucketFor("100"), eventType }),
    resolveBucketByCode: async (code) => ({ bucket: bucketFor(code), eventType }),
    findTarget: async () => targets.shift() ?? Promise.reject(new Error("no target left")),
    placeHold: (args) => placeRerouteHold(args, holds),
    releaseHold: (bookingId) => releaseRerouteHold(bookingId, holds),
    claimHold: async () => ({ refused: null, result: null, agentUserId: "NEW", targetBucketId: "b512" }),
    verifyFree: async (emails) => ({ free: new Set(emails.filter((e) => o.free.includes(e))), unverified: new Set() }),
    agentById: async (id) => (PEOPLE[id] ? { id, ...PEOPLE[id]! } : null),
    bucketById: async (id) => bucketFor(id.replace(/^b/, "")),
    reassign: async () => "moved",
    onReleaseFailed: () => {},
    keepSwap: async () => ({ refused: null, updated: true }),
    insertBookingEvent: async () => {},
    currentAdvisorUnavailable: async () => null,
    readLiveHold: async () => ({
      holdId: "H1", agentUserId: "NEW", targetBucketId: "b512", requestedBucketId: "b512", rungsDropped: 0, expiresAt: "2031-03-04T10:05:00.000Z",
    }),
    now: () => Date.parse("2031-03-04T10:00:00.000Z"),
  };
  return deps;
}

describe("start and confirm answer before the refresh (#3307)", () => {
  it("Find an advisor answers with the held advisor while the refresh is still to run", async () => {
    const started = track(startReroute(routeDeps({ targets: [moveTo("NEW")], free: [] }), { bookingId: "K1", bucketCode: "512", actor: { userId: "ADMIN" } as never }));
    await flush();
    expect(started.error).toBeUndefined();
    expect(started.settled).toBe(true);
    expect(started.value).toMatchObject({ kind: "move", holdId: "H1", advisor: { name: "Morgan Reyes" } });
    expect(slot.refreshPoolsForAgents).not.toHaveBeenCalled();
    expect(after.jobs).toHaveLength(1);
  });

  it("a confirm whose advisor was taken releases, searches and holds again, and answers before one refresh covering both", async () => {
    // The held advisor reads busy at confirm, so the confirm lets them go and holds
    // the next one found: two refreshes' worth of change in one request.
    const confirmed = track(
      confirmReroute(routeDeps({ targets: [moveTo("NEXT")], free: [] }), {
        bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor: { userId: "ADMIN" } as never,
      }),
    );
    await flush();
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.settled).toBe(true);
    expect(confirmed.value).toMatchObject({ kind: "taken", previous: { name: "Morgan Reyes" }, proposal: { kind: "move", advisor: { name: "Casey Lin" } } });
    expect(slot.refreshPoolsForAgents).not.toHaveBeenCalled();

    // One job, so the two refreshes do not run side by side inside the 30 seconds
    // Cloudflare gives work after the response; it covers both advisors.
    expect(after.jobs).toHaveLength(1);
    void after.jobs[0]!.work();
    await flush();
    expect(slot.refreshPoolsForAgents).toHaveBeenCalledTimes(1);
    expect(slot.refreshPoolsForAgents.mock.calls[0]![0].slice().sort()).toEqual(["NEW", "NEXT"]);
  });

  it("a confirm that moves answers without waiting on any refresh at all", async () => {
    const confirmed = track(
      confirmReroute(routeDeps({ targets: [], free: ["new@x.com"] }), {
        bookingId: "K1", holdId: "H1", bucketCode: null, note: null, actor: { userId: "ADMIN" } as never,
      }),
    );
    await flush();
    expect(confirmed.value).toMatchObject({ kind: "moved", advisor: { name: "Morgan Reyes" }, already: false });
  });
});
