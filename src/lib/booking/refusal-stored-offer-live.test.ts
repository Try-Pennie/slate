import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The live binding of the stored offer check (#3366, #3633, #3796). The decision is
// node-tested in scripts/test-refusal-stored-offer.ts against injected fakes; what
// only this file can see is that the REAL binding wires the real pieces in: the one
// `bucket_slots` read, the booking path's own coalesced pool refresh, run outside the
// request's budget, and the wait sized by what the failure path allowance has left.

const START = "2026-10-12T22:20:00.000Z";

const pending = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@/lib/after-response", () => ({
  afterResponse: (_context: string, work: () => Promise<unknown>) => {
    pending.push(work());
  },
}));

const slotCache = vi.hoisted(() => ({ refreshPoolOf: vi.fn(async (_code: string, _reason: string) => {}) }));
vi.mock("@/lib/availability/slot-cache", () => slotCache);

const rows = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ in: async () => ({ data: rows.current, error: null }) }) }),
  }),
}));

const trace = vi.hoisted(() => ({
  refusalTraceOf: vi.fn(() => ({
    requestedStart: "2026-10-12T22:20:00.000Z",
    bucketCode: "111",
    stage: "candidate_read_empty",
    rungs: [{ code: "111", members: 73, read: 0, claimed: 0, checked: null, stage: "candidate_read_empty" }],
    leadId: "00QUi000011BI7B",
  })),
}));
vi.mock("@/lib/booking/refusal-trace", () => trace);

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));

import { answerAfterRefusalRefresh } from "./refusal-stored-offer-live";
import { withinBookingCleanupBudget, BOOKING_CLEANUP_BUDGET_MS } from "./cleanup-allowance";
import { insideCallBudget, withinCallBudget } from "@/lib/call-budget";

const row = (slots: string[]) => ({
  bucket_code: "111",
  payload: { bucket: { code: "111" }, eventType: { duration_min: 20, min_notice_min: 0 }, orgName: "Pennie", slots },
  computed_at: "2026-10-12T04:16:37.417+00:00",
});

/** A refusal answered the way the routes answer one: inside the request's budget,
 *  under the failure path allowance. */
const refuse = (answer = async () => "409") =>
  withinCallBudget(12_000, "the booking confirm", () =>
    withinBookingCleanupBudget(() => answerAfterRefusalRefresh(new Error("refused"), answer)),
  );

const storedOfferLine = () =>
  logged.info.mock.calls.map((c) => c[1] as Record<string, unknown>).find((f) => f.msg === "refused time read against the stored row");

async function settle() {
  await Promise.all(pending.splice(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("answerAfterRefusalRefresh (#3633, #3796)", () => {
  it("resolves the stale pool's refresh BEFORE the refusal is answered", async () => {
    rows.current = [row([START])];
    const order: string[] = [];
    let release!: () => void;
    slotCache.refreshPoolOf.mockImplementationOnce(async () => {
      // Outside the request's budget, so the shared refresh is never cut at this
      // lead's allowance.
      order.push(insideCallBudget() ? "refresh inside a budget" : "refresh started");
      await new Promise<void>((r) => { release = r; });
      order.push("refresh resolved");
    });
    const answered = refuse().then((res) => { order.push(`answered ${res}`); });
    await vi.waitFor(() => expect(slotCache.refreshPoolOf).toHaveBeenCalled());
    expect(order).toEqual(["refresh started"]);
    release();
    await answered;
    expect(order).toEqual(["refresh started", "refresh resolved", "answered 409"]);
    // #3381: as the refusal's, so the row it writes names the refusal as its writer.
    expect(slotCache.refreshPoolOf).toHaveBeenCalledWith("111", "refusal");
    expect(storedOfferLine()?.refreshed_before_response).toBe(true);
    await settle();
  });

  it("answers once the allowance runs out, with the refresh still requested and carrying on", async () => {
    vi.useFakeTimers();
    rows.current = [row([START])];
    let release!: () => void;
    let refreshDone = false;
    slotCache.refreshPoolOf.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { release = r; });
      refreshDone = true;
    });
    let answered: string | null = null;
    const done = refuse().then((res) => { answered = res; });
    // Flushes the read and the refresh's start without moving the clock (`waitFor`
    // would advance fake timers while it polls, spending the allowance).
    await vi.advanceTimersByTimeAsync(0);
    expect(slotCache.refreshPoolOf).toHaveBeenCalledWith("111", "refusal");
    await vi.advanceTimersByTimeAsync(BOOKING_CLEANUP_BUDGET_MS - 100);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(answered).toBe("409");
    expect(refreshDone).toBe(false);
    expect(storedOfferLine()?.refreshed_before_response).toBe(false);
    // Kept alive past the response, and it finishes there.
    expect(pending.length).toBe(1);
    release();
    await settle();
    expect(refreshDone).toBe(true);
  });

  it("leaves the pool alone and holds nothing when the stored row was right", async () => {
    rows.current = [row(["2026-10-12T22:40:00.000Z"])];
    await expect(refuse()).resolves.toBe("409");
    await settle();
    expect(slotCache.refreshPoolOf).not.toHaveBeenCalled();
    expect(storedOfferLine()?.refreshed_before_response).toBeNull();
  });

  it("reads and holds nothing for an error that carries no refusal trace", async () => {
    trace.refusalTraceOf.mockReturnValueOnce(null as never);
    rows.current = [row([START])];
    await expect(refuse()).resolves.toBe("409");
    expect(pending.length).toBe(0);
    expect(slotCache.refreshPoolOf).not.toHaveBeenCalled();
  });

  it("lets a failure path that throws propagate, and the check still finishes", async () => {
    rows.current = [row([START])];
    await expect(refuse(async () => { throw new Error("tally down"); })).rejects.toThrow("tally down");
    await settle();
    expect(slotCache.refreshPoolOf).toHaveBeenCalledWith("111", "refusal");
    expect(storedOfferLine()?.refreshed_before_response).toBe(false);
  });
});
