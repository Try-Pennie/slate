import { describe, it, expect, vi, beforeEach } from "vitest";

// The live binding of the stored offer check (#3366, #3633). The decision is
// node-tested in scripts/test-refusal-stored-offer.ts against injected fakes; what
// only this file can see is that the REAL scheduler wires the real pieces in: the
// one `bucket_slots` read, and the booking path's own coalesced pool refresh, so a
// refusal that proves a stored offer stale actually refreshes that pool.

const START = "2026-10-12T22:20:00.000Z";

const pending = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@/lib/after-response", () => ({
  afterResponse: (_context: string, work: () => Promise<unknown>) => {
    pending.push(work());
  },
}));

const slotCache = vi.hoisted(() => ({ refreshPoolOf: vi.fn(async (_code: string) => {}) }));
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

vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { scheduleStoredOfferCheck } from "./refusal-stored-offer-live";

const row = (slots: string[]) => ({
  bucket_code: "111",
  payload: { bucket: { code: "111" }, eventType: { duration_min: 20, min_notice_min: 0 }, orgName: "Pennie", slots },
  computed_at: "2026-10-12T04:16:37.417+00:00",
});

async function settle() {
  await Promise.all(pending.splice(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

describe("scheduleStoredOfferCheck (#3633)", () => {
  it("refreshes the refused pool through the shared coalesced refresh when its stored row still offers the time", async () => {
    rows.current = [row([START])];
    scheduleStoredOfferCheck(new Error("refused"));
    await settle();
    expect(slotCache.refreshPoolOf).toHaveBeenCalledWith("111");
  });

  it("leaves the pool alone when the stored row was right", async () => {
    rows.current = [row(["2026-10-12T22:40:00.000Z"])];
    scheduleStoredOfferCheck(new Error("refused"));
    await settle();
    expect(slotCache.refreshPoolOf).not.toHaveBeenCalled();
  });

  it("schedules nothing for an error that carries no refusal trace", async () => {
    trace.refusalTraceOf.mockReturnValueOnce(null as never);
    rows.current = [row([START])];
    scheduleStoredOfferCheck(new Error("not a refusal"));
    await settle();
    expect(pending.length).toBe(0);
    expect(slotCache.refreshPoolOf).not.toHaveBeenCalled();
  });
});
