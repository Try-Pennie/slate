import { describe, it, expect, vi, beforeEach } from "vitest";

// The live-Google half of the availability-truth probe (#1315).
//
// What matters here is the ESCALATION and which way each unknown falls. A slot
// is offered because SOME eligible agent was believed free, so finding one
// genuinely free agent settles it in a single Google call, and only a suspected
// disagreement is worth spending the rest of the shared subrequest budget on.
//
// And the direction of every failure: an unreadable calendar must leave the slot
// unverified, never "drift". Scoring Google's own errors as drift would turn a
// Google blip into a page about our cache.

const supabaseAdmin = vi.hoisted(() => vi.fn());
const freeBusyMany = vi.hoisted(() => vi.fn());
const calendarsForEmails = vi.hoisted(() => vi.fn());
const freeAgentsFromBusy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/google/calendar", () => ({ freeBusyMany }));
vi.mock("@/lib/booking/service", () => ({ calendarsForEmails, FREEBUSY_MAX_ITEMS: 20 }));
vi.mock("@/lib/booking/core", () => ({ freeAgentsFromBusy }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin }));

import { verifySlotLive, driftAlertContext } from "./availability-truth-store";

const START = "2026-08-11T14:00:00.000Z";
const END = "2026-08-11T14:30:00.000Z";

/** 25 agents: two chunks at the 20-calendar cap, so escalation is observable. */
const MANY = Array.from({ length: 25 }, (_, i) => `a${i}@x`);

beforeEach(() => {
  vi.clearAllMocks();
  calendarsForEmails.mockImplementation(async (emails: string[]) => ({
    byEmail: new Map(emails.map((e) => [e, [e]])),
    readFailed: new Set<string>(),
  }));
  freeBusyMany.mockResolvedValue(new Map());
});

describe("verifySlotLive", () => {
  it("stops at the first chunk once any agent is genuinely free", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    expect(await verifySlotLive(MANY, START, END)).toBe("free");
    // The healthy case is the common case, so it must cost ONE call, not two.
    expect(freeBusyMany).toHaveBeenCalledTimes(1);
  });

  it("escalates to the remaining agents before calling anything drift", async () => {
    freeAgentsFromBusy
      .mockReturnValueOnce({ free: new Set(), needsFallback: new Set() })
      .mockReturnValueOnce({ free: new Set(["a22@x"]), needsFallback: new Set() });
    expect(await verifySlotLive(MANY, START, END)).toBe("free");
    expect(freeBusyMany).toHaveBeenCalledTimes(2);
  });

  it("reports drift only when EVERY eligible agent read cleanly and none is free", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set() });
    expect(await verifySlotLive(MANY, START, END)).toBe("drift");
    expect(freeBusyMany).toHaveBeenCalledTimes(2);
  });

  it("reports unverified when an agent's calendar could not be read", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set(["a3@x"]) });
    // The unread agent may well be free, so this is not evidence of drift.
    expect(await verifySlotLive(MANY, START, END)).toBe("unverified");
  });

  it("reports unverified when the users/calendars lookup failed for anyone", async () => {
    calendarsForEmails.mockResolvedValue({
      byEmail: new Map([["a0@x", ["a0@x"]]]),
      readFailed: new Set(["a1@x"]),
    });
    freeAgentsFromBusy.mockReturnValue({ free: new Set(), needsFallback: new Set() });
    expect(await verifySlotLive(["a0@x", "a1@x"], START, END)).toBe("unverified");
  });

  it("reports unverified when Google throws, rather than letting an outage read as drift", async () => {
    freeBusyMany.mockRejectedValue(new Error("backendError"));
    expect(await verifySlotLive(["a0@x"], START, END)).toBe("unverified");
  });

  it("asks Google about the booking's whole window", async () => {
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    await verifySlotLive(["a0@x"], START, END);
    expect(freeBusyMany).toHaveBeenCalledWith(expect.any(String), START, END, ["a0@x"]);
  });

  it("reports unverified when the slot window itself is unreadable", async () => {
    // A NaN bound would make every busy interval fail the overlap test, so every
    // agent would read FREE and the probe would quietly report no drift. That is
    // the guard silently passing, which is worse here than an error.
    freeAgentsFromBusy.mockReturnValue({ free: new Set(["a0@x"]), needsFallback: new Set() });
    expect(await verifySlotLive(["a0@x"], "not-a-timestamp", END)).toBe("unverified");
    expect(await verifySlotLive(["a0@x"], START, "")).toBe("unverified");
    expect(freeBusyMany).not.toHaveBeenCalled();
  });

  it("reports unverified for an empty eligible set rather than a vacuous drift", async () => {
    // No agents means no free agent, which is trivially true and says nothing
    // about the cache. The caller screens this out; the guard is defence in depth.
    expect(await verifySlotLive([], START, END)).toBe("unverified");
    expect(freeBusyMany).not.toHaveBeenCalled();
  });
});


// --- driftAlertContext (#1373): an unread state is NOT an empty set ---
//
// The whole aggregation rests on this. An empty set is the positive claim
// "nothing else is drifting", which suppresses the combined page and, on a
// healthy verdict, all-clears a condition still true off a read that never
// happened. The two shared helpers in notify/dispatch degrade a failed read to
// an empty set deliberately, which is right for their callers and exactly wrong
// here, so this reads strictly and the failure has to surface as null (L10/L11).

/** A supabase double whose `alert_state` read can be made to fail. */
function dbWith(opts: { buckets?: { code: string }[]; keys?: string[]; alertError?: string }) {
  return () => ({
    from: (table: string) => {
      if (table === "buckets") {
        const res = { data: opts.buckets ?? [{ code: "101" }, { code: "202" }], error: null };
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => Promise.resolve(res),
        };
        return chain;
      }
      const chain = {
        select: () => chain,
        in: () =>
          Promise.resolve(
            opts.alertError
              ? { data: null, error: { message: opts.alertError } }
              : { data: (opts.keys ?? []).map((key) => ({ key })), error: null },
          ),
      };
      return chain;
    },
  });
}

describe("driftAlertContext", () => {
  it("returns null when the alert state cannot be read, never an empty set", async () => {
    supabaseAdmin.mockImplementation(dbWith({ alertError: "column key does not exist" }));
    expect(await driftAlertContext()).toBeNull();
  });

  it("reports a genuinely empty state as empty, so a quiet system is not mistaken for a broken read", async () => {
    supabaseAdmin.mockImplementation(dbWith({ keys: [] }));
    const ctx = await driftAlertContext();
    expect(ctx).toEqual({
      seenDrifting: [],
      perBucketFiring: [],
      aggregateFiring: false,
      totalBuckets: 2,
    });
  });

  it("separates the drift markers from the firing pages and the aggregate", async () => {
    supabaseAdmin.mockImplementation(
      dbWith({
        keys: [
          "availability_drift_seen:101",
          "availability_drift_seen:202",
          "alert_firing:availability_drift:101",
          "alert_firing:availability_drift:all",
        ],
      }),
    );
    const ctx = await driftAlertContext();
    expect(ctx).toEqual({
      seenDrifting: ["101", "202"],
      perBucketFiring: ["101"],
      aggregateFiring: true,
      totalBuckets: 2,
    });
  });

  it("ignores a marker for a bucket no longer on the ladder, so it cannot keep the aggregate alive", async () => {
    supabaseAdmin.mockImplementation(
      dbWith({ buckets: [{ code: "101" }], keys: ["availability_drift_seen:999"] }),
    );
    const ctx = await driftAlertContext();
    expect(ctx?.seenDrifting).toEqual([]);
  });

  it("returns null when there are no buckets to rotate over", async () => {
    supabaseAdmin.mockImplementation(dbWith({ buckets: [] }));
    expect(await driftAlertContext()).toBeNull();
  });
});
