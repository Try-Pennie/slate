import { describe, it, expect, vi, beforeEach } from "vitest";

// #2915: the completion sweep's loader, as it is wired.
//
// With `booking.completed` gone, marking a finished booking completed needs
// nothing about it but its id, so the loader reads the id column of the bookings
// table and nothing else. It used to load every column and then fetch each row's
// bucket and event type, which only the webhook used, and a row whose bucket or
// event type could not be found was skipped for ever.

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

const calls = vi.hoisted(() => [] as Call[]);
const result = vi.hoisted(() => ({ data: [] as unknown, error: null as { message: string } | null }));

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "in", "lt", "limit"]) {
      q[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return q;
      };
    }
    q.then = (resolve: (r: typeof result) => unknown) => Promise.resolve(result).then(resolve);
    return q;
  }),
);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { realDeps } from "@/lib/booking/service";
import { PAST_COMPLETION_BATCH_LIMIT } from "@/lib/booking/core";

describe("loadPastBookingIdsToComplete (wired)", () => {
  beforeEach(() => {
    calls.length = 0;
    from.mockClear();
    result.data = [];
    result.error = null;
  });

  it("reads only the id column of due bookings and returns the ids", async () => {
    result.data = [{ id: "bk-1" }, { id: "bk-2" }];

    const ids = await realDeps().loadPastBookingIdsToComplete();

    expect(ids).toEqual(["bk-1", "bk-2"]);
    expect(calls.find((c) => c.method === "select")?.args[0]).toBe("id");
    expect(calls.find((c) => c.method === "in")?.args).toEqual(["status", ["confirmed", "rescheduled"]]);
    expect(calls.find((c) => c.method === "lt")?.args[0]).toBe("ends_at");
    expect(calls.find((c) => c.method === "limit")?.args[0]).toBe(PAST_COMPLETION_BATCH_LIMIT);
  });

  it("never reads buckets or event types", async () => {
    result.data = [{ id: "bk-1" }];

    await realDeps().loadPastBookingIdsToComplete();

    expect(from.mock.calls.map(([table]) => table)).toEqual(["bookings"]);
  });

  it("answers no ids on a failed read, so the tick completes nothing and the lane retries", async () => {
    result.data = null;
    result.error = { message: "statement timeout" };

    expect(await realDeps().loadPastBookingIdsToComplete()).toEqual([]);
  });
});
