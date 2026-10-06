import { describe, it, expect, vi, beforeEach } from "vitest";

// The read half of the monthly error budget check (#3179, #3374). What matters:
// the error mix by code reaches the pure judge from the SAME read as the counts,
// and a failed read throws rather than arriving as a month with no errors and no
// codes, which would clear a standing page and print a split nobody measured.

const rpc = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc })) }));
vi.mock("@/lib/supabase/admin", () => admin);

import { readMonthToDate } from "./slo-budget-store";

beforeEach(() => vi.clearAllMocks());

// 2026-10-06 15:00 UTC, an October day in the tally's zone.
const NOW = Date.UTC(2026, 9, 6, 15);

describe("readMonthToDate", () => {
  it("reads from the first of the month and carries the error mix by code", async () => {
    rpc.mockResolvedValue({
      data: {
        by_outcome: { created: 2400, cancelled: 75, error: 102 },
        by_error: { slot_unavailable: 78, invalid_request: 14, reschedule_slot_taken: 2, internal: 8 },
      },
      error: null,
    });
    const m = await readMonthToDate(NOW);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_since: "2026-10-01", p_include_test: false, p_include_offsite: false });
    expect(m).toMatchObject({ month: "2026-10", requests: 2577, errors: 102, serverFaults: 8 });
    expect(m.errorCodes).toEqual([
      { code: "slot_unavailable", count: 78 },
      { code: "invalid_request", count: 14 },
      { code: "internal", count: 8 },
      { code: "reschedule_slot_taken", count: 2 },
    ]);
  });

  it("THROWS on a failed read rather than answering an empty month", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied for function" } });
    await expect(readMonthToDate(NOW)).rejects.toThrow(/permission denied/);
  });
});
