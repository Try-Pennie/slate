import { describe, it, expect, vi, beforeEach } from "vitest";

// #4392: the program leads admin page's reads. Every one throws on a failure, so the page
// draws its unreadable state rather than a fortnight of zeros (L10); the outcomes read is
// bounded by its primary key and refuses a result that may have been cut short; and the
// calls are read only for the placeholder's bookings, from the early edge of the first.
const outcomes = vi.hoisted(() => ({ result: { data: [] as unknown[] | null, error: null as { message: string } | null }, filters: [] as unknown[][] }));
const store = vi.hoisted(() => ({
  loadProgramLeadBookings: vi.fn(async (): Promise<unknown[]> => []),
  loadCallFeedNewestReceivedMs: vi.fn(async (): Promise<number | null> => null),
  loadPlaceholderCalls: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@/lib/monitor/placeholder-calls-store", () => store);
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "gte", "lte", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          outcomes.filters.push([op, ...args]);
          return op === "limit" ? Promise.resolve(outcomes.result) : chain;
        };
      }
      return chain;
    },
  }),
}));

import { loadProgramLeadDays } from "./program-lead-days-load";

const NOW = Date.UTC(2026, 9, 29, 19, 0);

beforeEach(() => {
  vi.clearAllMocks();
  outcomes.result = { data: [], error: null };
  outcomes.filters = [];
  store.loadProgramLeadBookings.mockResolvedValue([]);
});

describe("loadProgramLeadDays (#4392)", () => {
  it("reads the outcomes for the 14 days, bounded one past every row the key allows", async () => {
    const rows = await loadProgramLeadDays(NOW);
    expect(rows).toHaveLength(14);
    expect(outcomes.filters).toContainEqual(["gte", "day", "2026-10-16"]);
    expect(outcomes.filters).toContainEqual(["lte", "day", "2026-10-29"]);
    expect(outcomes.filters).toContainEqual(["limit", 29]);
  });

  it("refuses an outcomes read that may have been cut short, rather than drawing part of it", async () => {
    outcomes.result = { data: Array.from({ length: 29 }, () => ({ day: "2026-10-20", kind: "times_fallback", occurrences: 1 })), error: null };
    await expect(loadProgramLeadDays(NOW)).rejects.toThrow(/more than 28 rows/);
  });

  it("throws on a failed outcomes read, never answering zero", async () => {
    outcomes.result = { data: null, error: { message: "boom" } };
    await expect(loadProgramLeadDays(NOW)).rejects.toThrow();
  });

  it("throws on a failed bookings read", async () => {
    store.loadProgramLeadBookings.mockRejectedValue(new Error("selectAllPages failed"));
    await expect(loadProgramLeadDays(NOW)).rejects.toThrow(/selectAllPages failed/);
  });

  it("reads calls only for the placeholder's bookings, from 15 minutes before the first", async () => {
    store.loadProgramLeadBookings.mockResolvedValue([
      { id: "a", kind: "routed", status: "confirmed", starts_at: "2026-10-27T14:00:00.000Z", ends_at: "2026-10-27T14:30:00.000Z", salesforce_id: "00Q5f00000ZZZZZQQQ", agent_name: "Ada" },
      { id: "b", kind: "staff_placed", status: "confirmed", starts_at: "2026-10-28T15:00:00.000Z", ends_at: "2026-10-28T15:30:00.000Z", salesforce_id: "00Q5f00000AbCdEFGH", agent_name: "Marcia" },
    ]);
    await loadProgramLeadDays(NOW);
    expect(store.loadPlaceholderCalls).toHaveBeenCalledWith(expect.anything(), ["00Q5f00000AbCdE"], "2026-10-28T14:45:00.000Z");
  });

  it("asks for no calls when nothing is on the placeholder", async () => {
    await loadProgramLeadDays(NOW);
    expect(store.loadPlaceholderCalls).not.toHaveBeenCalled();
  });
});
