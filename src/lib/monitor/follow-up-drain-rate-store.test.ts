import { describe, it, expect, vi, beforeEach } from "vitest";

// #3267: the IO half of the follow up drain share. Its window lives in its own row
// of booking_failure_rate_state, and its counts come off the SAME tally read the
// failure rate makes, so the monitor lane pays nothing extra for it on a tick where
// both run. A failed read or write must throw, never read as a first run or a
// healthy hour.

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

import { loadFollowUpState, saveFollowUpState, followUpReadingOf } from "./follow-up-drain-rate-store";
import { readTodayMix, outcomeReadingOf } from "./booking-failure-rate-store";

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({ error: null });
});

describe("the follow up reading off today's tally (#3267)", () => {
  it("counts the confirms that committed against the ones that left work to the drain", async () => {
    rpc.mockResolvedValue({
      data: {
        by_outcome: { created: 80, rescheduled: 5, error: 10, follow_up_left_to_drain: 4 },
        by_error: { internal: 10 },
      },
      error: null,
    });
    const today = await readTodayMix(Date.UTC(2026, 9, 16, 18, 0, 0));
    const reading = followUpReadingOf(today);
    expect(reading).toEqual({ day: "2026-10-16", attempts: 80, failures: 4, byCode: {} });
  });

  it("leaves the failure share exactly as it was: the row is not an attempt", async () => {
    rpc.mockResolvedValue({
      data: { by_outcome: { created: 80, rescheduled: 5, error: 10, follow_up_left_to_drain: 4 }, by_error: {} },
      error: null,
    });
    const share = outcomeReadingOf(await readTodayMix(Date.UTC(2026, 9, 16, 18, 0, 0)));
    expect(share.attempts).toBe(95);
    expect(share.failures).toBe(10);
  });

  it("THROWS when the tally read fails, rather than reading an hour with nothing left behind", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "statement timeout" } });
    await expect(readTodayMix(Date.now())).rejects.toThrow(/statement timeout/);
  });
});

describe("the follow up window's own state row (#3267)", () => {
  it("reads its own key, never the failure rate's", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await loadFollowUpState()).toBeNull();
    expect(eqKey).toHaveBeenCalledWith("key", "booking_follow_up");
  });

  it("THROWS on a failed read, so a lost window is never a first run", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(loadFollowUpState()).rejects.toThrow(/permission denied/);
  });

  it("reads the row back as a window", async () => {
    maybeSingle.mockResolvedValue({
      data: { key: "booking_follow_up", day: "2026-10-16", attempts: 80, failures: 4, by_code: null, refusals: {}, samples: [] },
      error: null,
    });
    expect(await loadFollowUpState()).toEqual({ day: "2026-10-16", attempts: 80, failures: 4, byCode: {}, samples: [] });
  });

  it("writes under its own key, and THROWS on a refused write", async () => {
    await saveFollowUpState({ day: "2026-10-16", attempts: 80, failures: 4, byCode: {}, samples: [] });
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ key: "booking_follow_up", attempts: 80, failures: 4, refusals: {} });
    expect(upsert.mock.calls[0]?.[1]).toEqual({ onConflict: "key" });
    upsert.mockResolvedValue({ error: { message: "read only transaction" } });
    await expect(
      saveFollowUpState({ day: "2026-10-16", attempts: 80, failures: 4, byCode: {}, samples: [] }),
    ).rejects.toThrow(/read only transaction/);
  });
});
