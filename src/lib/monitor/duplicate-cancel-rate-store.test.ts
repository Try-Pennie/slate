import { describe, it, expect, vi, beforeEach } from "vitest";

// #2377: the IO half of the duplicate cancel share. Its counts come off the SAME tally
// read the failure rate makes, and stay out of the failure share; its window lives in
// its own row. A failed read or write must throw, never read as a first run or a
// quiet day.

const rpc = vi.hoisted(() => vi.fn());
const maybeSingle = vi.hoisted(() => vi.fn());
const eqKey = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc,
    from: () => ({
      select: () => ({
        eq: (col: string, value: string) => {
          eqKey(col, value);
          return { maybeSingle };
        },
      }),
      upsert,
    }),
  }),
}));

import { duplicateCancelReadingOf, loadDuplicateCancelState, saveDuplicateCancelState } from "./duplicate-cancel-rate-store";
import { readTodayMix, outcomeReadingOf } from "./booking-failure-rate-store";

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({ error: null });
});

const TALLY = {
  created: 80,
  error: 10,
  duplicate_cancel_cancelled: 3,
  duplicate_cancel_no_other_call: 2,
  duplicate_cancel_unavailable_rpc: 4,
};

describe("the duplicate cancel reading off today's tally (#2377)", () => {
  it("counts every duplicate cancel answer as a call and the 503 stages as failures", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: TALLY, by_error: {} }, error: null });
    const reading = duplicateCancelReadingOf(await readTodayMix(Date.UTC(2026, 9, 16, 18, 0, 0)));
    expect(reading).toEqual({
      day: "2026-10-16",
      attempts: 9,
      failures: 4,
      byCode: {
        duplicate_cancel_cancelled: 3,
        duplicate_cancel_no_other_call: 2,
        duplicate_cancel_unavailable_rpc: 4,
      },
    });
  });

  it("leaves the booking failure share exactly as it was", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: TALLY, by_error: {} }, error: null });
    const share = outcomeReadingOf(await readTodayMix(Date.UTC(2026, 9, 16, 18, 0, 0)));
    expect(share.attempts).toBe(90);
    expect(share.failures).toBe(10);
  });

  it("THROWS when the tally read fails, rather than reading a day with no calls", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "statement timeout" } });
    await expect(readTodayMix(Date.now())).rejects.toThrow(/statement timeout/);
  });
});

describe("the duplicate cancel window's own state row (#2377)", () => {
  it("reads its own key", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await loadDuplicateCancelState()).toBeNull();
    expect(eqKey).toHaveBeenCalledWith("key", "duplicate_cancel");
  });

  it("THROWS on a failed read, so a lost window is never a first run", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(loadDuplicateCancelState()).rejects.toThrow(/permission denied/);
  });

  it("writes under its own key, and THROWS on a refused write", async () => {
    await saveDuplicateCancelState({ day: "2026-10-16", attempts: 9, failures: 4, byCode: {}, samples: [] });
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ key: "duplicate_cancel", attempts: 9, failures: 4, refusals: {} });
    upsert.mockResolvedValue({ error: { message: "read only transaction" } });
    await expect(
      saveDuplicateCancelState({ day: "2026-10-16", attempts: 9, failures: 4, byCode: {}, samples: [] }),
    ).rejects.toThrow(/read only transaction/);
  });
});
