import { describe, it, expect, vi, beforeEach } from "vitest";

// #532: each user must have at most one availability_schedules row, enforced by
// a unique index on (user_id). The get-or-create step the three admin hours
// actions duplicated is consolidated into upsertUserSchedule, which must upsert
// on that conflict target (crash-safe: a concurrent create settles on the index
// instead of racing to a second row) rather than the old check-then-insert.

const single = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() =>
  vi.fn(() => ({ select: () => ({ single }) })),
);
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { upsertUserSchedule } from "@/lib/schedule";

beforeEach(() => {
  single.mockReset();
  upsert.mockClear();
  from.mockClear();
});

describe("upsertUserSchedule", () => {
  it("upserts on the (user_id) conflict target and returns the row id", async () => {
    single.mockResolvedValue({ data: { id: "sched-1" }, error: null });

    const id = await upsertUserSchedule("user-1", "America/New_York");

    expect(id).toBe("sched-1");
    expect(from).toHaveBeenCalledWith("availability_schedules");
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "user-1", timezone: "America/New_York" },
      { onConflict: "user_id" },
    );
  });

  it("throws (fails loud) when the upsert errors instead of returning a blank id", async () => {
    single.mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(upsertUserSchedule("user-1", "America/New_York")).rejects.toThrow(
      /boom/,
    );
  });
});
