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

const freeBusyMany = vi.hoisted(() => vi.fn());
const calendarsForEmails = vi.hoisted(() => vi.fn());
const freeAgentsFromBusy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/google/calendar", () => ({ freeBusyMany }));
vi.mock("@/lib/booking/service", () => ({ calendarsForEmails, FREEBUSY_MAX_ITEMS: 20 }));
vi.mock("@/lib/booking/core", () => ({ freeAgentsFromBusy }));

import { verifySlotLive } from "./availability-truth-store";

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
