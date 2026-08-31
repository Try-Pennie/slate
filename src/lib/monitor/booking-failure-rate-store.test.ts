import { describe, it, expect, vi, beforeEach } from "vitest";

// The IO half of the booking-failure-rate page (#1313): reading today's
// cumulative tally and loading/saving the one rolling-window state row.
//
// What matters here is the distinction the pure logic depends on and cannot make
// for itself: "there is no state yet" (a first run, fine) versus "the state could
// not be READ" (which must reach the caller as a throw, so the tick reports
// unverified instead of silently resetting the window and calling it healthy).
// Same for the tally: a failed RPC must never present as a day with no failures.

const rpc = vi.hoisted(() => vi.fn());
const maybeSingle = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() =>
  vi.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle }) }),
    upsert,
  })),
);
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc, from })) }));
vi.mock("@/lib/supabase/admin", () => admin);

import { loadRateState, saveRateState, readTodayOutcomes } from "./booking-failure-rate-store";

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({ error: null });
});

describe("loadRateState", () => {
  it("returns null when no state row exists yet (a first run is not a failure)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await loadRateState()).toBeNull();
  });

  it("THROWS when the state row could not be read, rather than reading as no state", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "relation missing" } });
    // Silently returning null here would reset the window on every tick, which
    // presents as a permanently unjudgeable (and so permanently silent) check.
    await expect(loadRateState()).rejects.toThrow(/relation missing/);
  });

  it("maps the stored row onto the window shape the pure logic consumes", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        key: "monitor",
        day: "2026-08-11",
        attempts: 900,
        failures: 40,
        by_code: { slot_unavailable: 30 },
        samples: [{ atMs: 1, attempts: 2, failures: 1, byCode: { internal: 1 } }],
      },
      error: null,
    });
    const state = await loadRateState();
    expect(state).toEqual({
      day: "2026-08-11",
      attempts: 900,
      failures: 40,
      byCode: { slot_unavailable: 30 },
      samples: [{ atMs: 1, attempts: 2, failures: 1, byCode: { internal: 1 } }],
    });
  });

  it("tolerates a row written before the jsonb columns had values", async () => {
    maybeSingle.mockResolvedValue({
      data: { key: "monitor", day: "2026-08-11", attempts: 1, failures: 0, by_code: null, samples: null },
      error: null,
    });
    const state = await loadRateState();
    expect(state?.samples).toEqual([]);
    expect(state?.byCode).toEqual({});
  });
});

describe("saveRateState", () => {
  it("upserts the single row on its fixed key, so ticks can never accumulate rows", async () => {
    await saveRateState({
      day: "2026-08-11",
      attempts: 5,
      failures: 1,
      byCode: { internal: 1 },
      samples: [],
    });
    expect(upsert).toHaveBeenCalledOnce();
    const [row, opts] = upsert.mock.calls[0];
    expect(row).toMatchObject({ day: "2026-08-11", attempts: 5, failures: 1 });
    expect(row.key).toBeTruthy();
    expect(opts).toMatchObject({ onConflict: "key" });
  });

  it("throws when the write fails, so the caller cannot report a saved window it never saved", async () => {
    upsert.mockResolvedValue({ error: { message: "read only transaction" } });
    await expect(
      saveRateState({ day: "2026-08-11", attempts: 1, failures: 0, byCode: {}, samples: [] }),
    ).rejects.toThrow(/read only transaction/);
  });
});

describe("readTodayOutcomes", () => {
  it("sums every outcome into attempts and carries the error slice by code", async () => {
    rpc.mockResolvedValue({
      data: {
        by_outcome: { created: 80, rescheduled: 5, deduped: 3, confirm_required: 2, error: 10 },
        by_error: { slot_unavailable: 8, internal: 2 },
      },
      error: null,
    });
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(reading.attempts).toBe(100);
    expect(reading.failures).toBe(10);
    expect(reading.byCode).toEqual({ slot_unavailable: 8, internal: 2 });
    expect(reading.day).toBe("2026-08-11");
  });

  it("asks for TODAY's ET day, so the window is measured against the same day the tally buckets by", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {} }, error: null });
    // 01:00 UTC on the 12th is still the 11th in Eastern time.
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 12, 1, 0, 0));
    expect(reading.day).toBe("2026-08-11");
    expect(rpc).toHaveBeenCalledWith("booking_api_outcome_mix", {
      p_since: "2026-08-11",
      p_include_test: false,
    });
  });

  // #1616. Before cutover EVERY attempt in the tally is the smoke canary's, and
  // exactly one per pass is a reschedule_conflict the canary raises on purpose, so
  // a reading that counts it measures the test harness. The exclusion is asserted
  // at the reading site rather than trusted to the RPC's own default, which nothing
  // in this repo can see.
  it("asks the tally to EXCLUDE test traffic, so the canary is not the thing being measured", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {}, test_total: 16 }, error: null });
    await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_include_test: false });
  });

  it("reads a day of nothing but excluded canary traffic as zero attempts, not as a failure", async () => {
    // What production looks like while the roster is dark: the canary wrote 16
    // rows and every one of them was filtered out by the RPC, so the window has
    // nothing to judge and the check parks instead of concluding.
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {}, test_total: 16 }, error: null });
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(reading.attempts).toBe(0);
    expect(reading.failures).toBe(0);
    expect(reading.byCode).toEqual({});
  });

  it("THROWS when the tally read fails, rather than reporting a day with no failures", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    await expect(readTodayOutcomes(Date.now())).rejects.toThrow(/function does not exist/);
  });

  it("reads a genuinely empty day as zeroes, which is a real measurement", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {} }, error: null });
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(reading.attempts).toBe(0);
    expect(reading.failures).toBe(0);
  });
});
