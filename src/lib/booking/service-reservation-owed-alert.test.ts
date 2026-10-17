import { describe, it, expect, vi, beforeEach } from "vitest";

// #3847: the reservation lane's owed alert (`reservation_created_owed`) settles
// AFTER the drain and the retention sweep have run. Its page seam already logged a
// failed send rather than rejecting; its all-clear seam did not, so a throwing
// recovery notice rejected the whole `drainBookingReservations` call, turning a
// tick whose work had landed into a failed lane run. Both seams now log and go on.

const state = vi.hoisted(() => ({
  resolveFailure: null as Error | null,
  logged: [] as { key: string; err: unknown }[],
}));

// Every read answers empty and every count zero: no drainable reservation, no
// stored stuck row, no expired candidate. So the stuck alert and the owed alert
// both measure healthy and both reach their all-clear seams.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "lt", "gte", "in", "or", "order", "range", "limit", "delete"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return chain;
    },
  }),
}));

vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
  // Only the owed alert's all-clear fails, so the stuck alert's all-clear beside it
  // (settled first, on the same lane) is not what this test trips over.
  resolveRecovered: vi.fn(async (entries: { key: string }[]) => {
    if (state.resolveFailure && entries.some((e) => e.key === "reservation_created_owed")) {
      throw state.resolveFailure;
    }
    return [];
  }),
}));

vi.mock("@/lib/notify/send-failure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/send-failure")>()),
  logAlertSendFailure: (key: string) => (err: unknown) => {
    state.logged.push({ key, err });
  },
}));

import { drainBookingReservations } from "./service";
import { resolveRecovered } from "@/lib/notify/dispatch";

beforeEach(() => {
  state.resolveFailure = null;
  state.logged = [];
  vi.mocked(resolveRecovered).mockClear();
});

describe("drainBookingReservations: the owed alert's all-clear (#3847)", () => {
  it("a recovery notice that throws is logged, and the drain still resolves", async () => {
    state.resolveFailure = new Error("alert_state write refused");
    await expect(drainBookingReservations()).resolves.toMatchObject({ processed: 0 });
    expect(state.logged).toEqual([{ key: "reservation_created_owed", err: state.resolveFailure }]);
  });

  it("CONTROL: a healthy sweep asks to clear the owed alert, and logs nothing", async () => {
    await expect(drainBookingReservations()).resolves.toMatchObject({ processed: 0 });
    const keys = vi.mocked(resolveRecovered).mock.calls.flatMap(([entries]) => entries.map((e) => e.key));
    expect(keys).toContain("reservation_created_owed");
    expect(state.logged).toEqual([]);
  });
});
