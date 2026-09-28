import { describe, it, expect, vi, beforeEach } from "vitest";

// The IO half of the race whisper (#2838): one read of today's booking outcome
// tally. What matters is the distinction the pure verdict cannot make for itself:
// a day with no races versus a tally that could not be READ. A failed RPC must
// reach the caller as a throw, never as a quiet day.

const rpc = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc })) }));
vi.mock("@/lib/supabase/admin", () => admin);

import { readRaceContentionWindow } from "./race-contention-store";

// 2026-09-28 16:00 UTC is noon Eastern on the 28th.
const NOW = Date.UTC(2026, 8, 28, 16, 0, 0);

beforeEach(() => vi.clearAllMocks());

describe("readRaceContentionWindow", () => {
  it("reads today's Eastern day with the canary and off site testers left out", async () => {
    rpc.mockResolvedValue({
      data: { by_outcome: { created: 60, race_reassigned: 2, race_refused: 1, race_refused_bound: 1, error: 9 } },
      error: null,
    });
    const w = await readRaceContentionWindow(NOW);
    expect(rpc).toHaveBeenCalledWith("booking_api_outcome_mix", {
      p_since: "2026-09-28",
      p_include_test: false,
      p_include_offsite: false,
    });
    expect(w).toEqual({ day: "2026-09-28", created: 60, reassigned: 2, refused: 1, refusedAtBound: 1 });
  });

  it("keys the day on Eastern time, not UTC", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {} }, error: null });
    // 02:00 UTC on the 29th is still the 28th in New York.
    await readRaceContentionWindow(Date.UTC(2026, 8, 29, 2, 0, 0));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_since: "2026-09-28" });
  });

  it("THROWS on a failed read, rather than reading as a day with no races", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function missing" } });
    await expect(readRaceContentionWindow(NOW)).rejects.toThrow(/function missing/);
  });

  it("THROWS on an answer with no outcome map, rather than reading as zero", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(readRaceContentionWindow(NOW)).rejects.toThrow(/could not be read/);
  });

  it("reads an empty day as zeros, which the verdict then calls unmeasured", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {} }, error: null });
    expect(await readRaceContentionWindow(NOW)).toEqual({
      day: "2026-09-28",
      created: 0,
      reassigned: 0,
      refused: 0,
      refusedAtBound: 0,
    });
  });
});
