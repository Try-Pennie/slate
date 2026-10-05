import { describe, it, expect, vi, beforeEach } from "vitest";

// #2345: the slot refresh a booking triggers (`invalidateSlots`) was a FLOATING
// promise: `void recomputeBucketSlotsForToday(...)`. That is a whole pool compute,
// seconds of CPU on the load test Worker, started in the MIDDLE of the confirm, so
// it shared the isolate's one thread with the rest of the confirm a lead is waiting
// on, ran on past the response, and was reported by nothing (the load run's per job
// line named only the tally). On Workers a promise still pending when the response
// resolves is not guaranteed to run at all (#191, #503).
//
// These pin both sides of the split: the user-facing paths (which pass a webhook
// scheduler) go through afterResponse under their own name, and the cron drains
// (which pass none) keep the float #503 decided on, because waitUntil there would
// hold the shared minute invocation open for the recompute.

const after = vi.hoisted(() => ({
  afterResponse: vi.fn((_context: string, _work: () => Promise<unknown>) => {}),
  deferWebhookSend: vi.fn(),
}));
vi.mock("@/lib/after-response", () => after);

const slotCache = vi.hoisted(() => ({
  recomputeBucketSlotsForToday: vi.fn(async (_code: string) => {}),
  refreshPoolAfterBooking: vi.fn(async (_code: string) => {}),
  readPoolInputsAfterBooking: vi.fn(async (_code: string) => {}),
  spliceBookedTimeAfterBooking: vi.fn(async (_code: string, _booked: unknown) => {}),
  readSpliceInputsAfterBooking: vi.fn(async (_code: string, _booked: unknown) => {}),
  getBucketSlotsWithFallback: vi.fn(),
  refreshPoolsForAgents: vi.fn(),
}));
vi.mock("@/lib/availability/slot-cache", () => slotCache);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));

import { realDeps } from "./service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a user-facing booking's slot refresh runs after the response (#2345)", () => {
  it("is handed to afterResponse under its own name instead of being started inline", async () => {
    await realDeps(after.deferWebhookSend).invalidateSlots("411");

    expect(after.afterResponse).toHaveBeenCalledTimes(1);
    expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute");
    // Nothing has been computed yet: the confirm carries on without sharing its
    // thread with a pool compute.
    expect(slotCache.refreshPoolAfterBooking).not.toHaveBeenCalled();

    await after.afterResponse.mock.calls[0][1]();
    expect(slotCache.refreshPoolAfterBooking).toHaveBeenCalledWith("411");
    // #3258: never the per code compute the load run measured crowding the confirms.
    expect(slotCache.recomputeBucketSlotsForToday).not.toHaveBeenCalled();
  });

  it("lets a failed refresh REJECT, so afterResponse logs it and its profile says it failed", async () => {
    slotCache.refreshPoolAfterBooking.mockRejectedValueOnce(new Error("bucket_slots write refused"));

    await realDeps(after.deferWebhookSend).invalidateSlots("411");
    const work = after.afterResponse.mock.calls[0][1];

    // Swallowing it here would have the per job profile report a failed refresh as
    // a free one (L515), and the warning afterResponse writes is the trace (#1049).
    await expect(work()).rejects.toThrow(/write refused/);
  });
});

// #3258: the user facing refresh is the booked code's POOL, coalesced with the
// pool's other bookings (refreshPoolAfterBooking), never the per code recompute the
// load run measured crowding the confirms. The cron drains keep the per code float.
describe("a cron drain's slot refresh keeps the #503 float", () => {
  it("starts the recompute directly and never asks waitUntil to hold the lane open", async () => {
    await realDeps().invalidateSlots("411");

    expect(after.afterResponse).not.toHaveBeenCalled();
    expect(slotCache.recomputeBucketSlotsForToday).toHaveBeenCalledWith("411");
  });

  it("does not let a failed float reach the drain", async () => {
    slotCache.recomputeBucketSlotsForToday.mockRejectedValueOnce(new Error("refused"));

    await expect(realDeps().invalidateSlots("411")).resolves.toBeUndefined();
  });
});

// #3258: the load test switch, driven through the real deps so the wiring is what
// is proved, not a helper beside it.
describe("the post confirm recompute arm (#3258)", () => {
  const VAR = "SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE";
  const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("off schedules nothing after a load test booking", async () => {
    await withEnv({ SLATE_LOADTEST: "true", [VAR]: "off" }, async () => {
      await realDeps(after.deferWebhookSend).invalidateSlots("212");
      expect(after.afterResponse).not.toHaveBeenCalled();
      expect(slotCache.refreshPoolAfterBooking).not.toHaveBeenCalled();
    });
  });

  it("reads-only schedules the reads under their own name, and never the recompute", async () => {
    await withEnv({ SLATE_LOADTEST: "true", [VAR]: "reads-only" }, async () => {
      await realDeps(after.deferWebhookSend).invalidateSlots("212");
      expect(after.afterResponse).toHaveBeenCalledTimes(1);
      expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute-reads-only");
      await after.afterResponse.mock.calls[0][1]();
      expect(slotCache.readPoolInputsAfterBooking).toHaveBeenCalledWith("212");
      expect(slotCache.refreshPoolAfterBooking).not.toHaveBeenCalled();
    });
  });

  it("production ignores the switch, even set to off", async () => {
    await withEnv({ SLATE_LOADTEST: undefined, [VAR]: "off" }, async () => {
      await realDeps(after.deferWebhookSend).invalidateSlots("212");
      expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute");
      await after.afterResponse.mock.calls[0][1]();
      expect(slotCache.refreshPoolAfterBooking).toHaveBeenCalledWith("212");
    });
  });

  it("the cron drain's float is not switched", async () => {
    await withEnv({ SLATE_LOADTEST: "true", [VAR]: "off" }, async () => {
      await realDeps().invalidateSlots("212");
      expect(slotCache.recomputeBucketSlotsForToday).toHaveBeenCalledWith("212");
    });
  });

  it("reads-only after a create reads the splice's inputs, never the pool's", async () => {
    const booked = { userId: "agent-a", startsAt: "2026-10-13T14:00:00.000Z", endsAt: "2026-10-13T14:20:00.000Z" };
    await withEnv({ SLATE_LOADTEST: "true", [VAR]: "reads-only" }, async () => {
      await realDeps(after.deferWebhookSend).invalidateSlots("212", booked);
      expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute-reads-only");
      await after.afterResponse.mock.calls[0][1]();
      expect(slotCache.readSpliceInputsAfterBooking).toHaveBeenCalledWith("212", expect.objectContaining(booked));
      expect(slotCache.readPoolInputsAfterBooking).not.toHaveBeenCalled();
      expect(slotCache.spliceBookedTimeAfterBooking).not.toHaveBeenCalled();
    });
  });
});

// #3324: a create hands over the booked advisor and window, and the refresh becomes
// a splice of that window into every pool the advisor serves, rather than a whole
// pool compute of the booked code's pool alone.
describe("a confirmed booking splices its window (#3324)", () => {
  const BOOKED = { userId: "agent-a", startsAt: "2026-10-13T14:00:00.000Z", endsAt: "2026-10-13T14:20:00.000Z" };

  it("schedules the splice under the same job name, with the fence stamped when the confirm asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-12T15:00:00.000Z"));
      await realDeps(after.deferWebhookSend).invalidateSlots("411", BOOKED);
      // Later than the confirm: the fence must still be the confirm's instant, which
      // is after the busy block committed and before any later compute began.
      vi.setSystemTime(Date.parse("2026-10-12T15:00:09.000Z"));

      expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute");
      expect(slotCache.spliceBookedTimeAfterBooking).not.toHaveBeenCalled();
      await after.afterResponse.mock.calls[0][1]();
      expect(slotCache.spliceBookedTimeAfterBooking).toHaveBeenCalledWith("411", {
        ...BOOKED,
        fenceAtMs: Date.parse("2026-10-12T15:00:00.000Z"),
      });
      // The whole pool compute it replaces is not run beside it.
      expect(slotCache.refreshPoolAfterBooking).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a failed splice REJECT, so afterResponse logs it", async () => {
    slotCache.spliceBookedTimeAfterBooking.mockRejectedValueOnce(new Error("2 code(s) could not be spliced"));
    await realDeps(after.deferWebhookSend).invalidateSlots("411", BOOKED);
    await expect(after.afterResponse.mock.calls[0][1]()).rejects.toThrow(/could not be spliced/);
  });

  it("a refresh with no booked window (a cancel) still refreshes the pool", async () => {
    await realDeps(after.deferWebhookSend).invalidateSlots("411");
    await after.afterResponse.mock.calls[0][1]();
    expect(slotCache.refreshPoolAfterBooking).toHaveBeenCalledWith("411");
    expect(slotCache.spliceBookedTimeAfterBooking).not.toHaveBeenCalled();
  });

  // #3334: a reschedule or reassign hands over the window it LEFT as well, and the
  // splice gets both under the one fence, stamped when the step asked (after the
  // busy block's move had committed), never the pool refresh beside it.
  it("a move hands the splice both windows under the step's fence", async () => {
    const MOVE = {
      ...BOOKED,
      freed: { userId: "agent-b", startsAt: "2026-10-13T15:00:00.000Z", endsAt: "2026-10-13T15:20:00.000Z" },
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-12T15:00:00.000Z"));
      await realDeps(after.deferWebhookSend).invalidateSlots("411", MOVE);
      vi.setSystemTime(Date.parse("2026-10-12T15:00:09.000Z"));
      expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute");
      await after.afterResponse.mock.calls[0][1]();
      expect(slotCache.spliceBookedTimeAfterBooking).toHaveBeenCalledWith("411", {
        ...MOVE,
        fenceAtMs: Date.parse("2026-10-12T15:00:00.000Z"),
      });
      expect(slotCache.refreshPoolAfterBooking).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
