import { describe, it, expect, vi, beforeEach } from "vitest";

// setEventTypeGap: the gap an admin keeps between two calls on one advisor
// (BC, 2026-10-02: cal.com kept 10 minutes as a cap on capacity, and the move to
// Slate dropped it). One number sets BOTH buffers, because Slate pads only the
// call being offered: a buffer after alone still lets a new call start the minute
// an earlier one ends.
//
// The failure paths matter as much as the save. A redirect saying "saved" over a
// write that errored or matched nothing would leave advisors stacked while the
// admin believed the gap was in place (L12).
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
/** The update chain: .update(...).eq("id").eq("org_id") resolves to { error, count }. */
const result = vi.hoisted(() => ({ error: null as { message: string } | null, count: 1 as number }));
const eqCalls = vi.hoisted(() => [] as [string, string][]);
const updateArgs = vi.hoisted(() => [] as unknown[]);
const chain = vi.hoisted(() => {
  const thenable = {
    eq(col: string, val: string) {
      eqCalls.push([col, val]);
      return thenable;
    },
    then(res: (v: unknown) => unknown) {
      return Promise.resolve(res({ error: result.error, count: result.count }));
    },
  };
  return thenable;
});
const update = vi.hoisted(() => vi.fn((...args: unknown[]) => {
  updateArgs.push(args[0]);
  return chain;
}));
/** The read of the current gap, for the audit's old value. */
const current = vi.hoisted(() => ({
  row: { buffer_before_min: 0, buffer_after_min: 0 } as Record<string, number> | null,
  error: null as { message: string } | null,
}));
const selectChain = vi.hoisted(() => {
  const c = {
    eq: () => c,
    maybeSingle: async () => ({ data: current.row, error: current.error }),
    // createEventType's duplicate title check awaits the chain itself.
    then: (res: (v: unknown) => unknown) => Promise.resolve(res({ data: [], error: null })),
  };
  return c;
});
const inserted = vi.hoisted(() => [] as Record<string, unknown>[]);
const insert = vi.hoisted(() =>
  vi.fn((row: Record<string, unknown>) => {
    inserted.push(row);
    return { select: () => ({ single: async () => ({ data: { id: "et-new" }, error: null }) }) };
  }),
);
const from = vi.hoisted(() => vi.fn(() => ({ update, insert, select: () => selectChain })));
const markAllBucketSlotsStale = vi.hoisted(() => vi.fn(async () => 3));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { createEventType, setEventTypeGap } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  updateArgs.length = 0;
  inserted.length = 0;
  result.error = null;
  result.count = 1;
  current.row = { buffer_before_min: 0, buffer_after_min: 0 };
  current.error = null;
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

/** The action always ends in a redirect, which the mock throws. */
async function run(entries: Record<string, string>): Promise<string> {
  try {
    await setEventTypeGap(form(entries));
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

describe("setEventTypeGap", () => {
  it("is admin only", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("nope"));
    await expect(setEventTypeGap(form({ event_type_id: "et1", gap_min: "10" }))).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("sets both buffers to the gap, scoped to the admin's org, and refreshes what the booker serves", async () => {
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toBe("/admin/event-types?ok=event-type-gap");
    expect(updateArgs[0]).toEqual({ buffer_before_min: 10, buffer_after_min: 10 });
    expect(eqCalls).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
    ]);
    // The buffer rides in the cached slots payload, so the booker must rebuild.
    expect(markAllBucketSlotsStale).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          event_type_id: "et1",
          from: { buffer_before_min: 0, buffer_after_min: 0 },
          to: { buffer_before_min: 10, buffer_after_min: 10 },
        }),
      }),
    );
  });

  it("accepts zero, which removes the gap", async () => {
    await run({ event_type_id: "et1", gap_min: "0" });
    expect(updateArgs[0]).toEqual({ buffer_before_min: 0, buffer_after_min: 0 });
  });

  it.each(["", "abc", "-5", "7.5", "121"])("refuses %j without writing anything", async (gap) => {
    const to = await run({ event_type_id: "et1", gap_min: gap });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no event type", async () => {
    const to = await run({ gap_min: "10" });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
  });

  it("tells the admin when the write itself failed, and claims nothing", async () => {
    result.error = { message: "connection lost" };
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("tells the admin when the call type is not one of theirs", async () => {
    current.row = null;
    const to = await run({ event_type_id: "someone-elses", gap_min: "10" });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("tells the admin when the save matched no row", async () => {
    result.count = 0;
    const to = await run({ event_type_id: "et1", gap_min: "10" });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// The add form asks for the same one number, for the same reason: a buffer on one
// side alone still lets two calls touch.
describe("createEventType gap", () => {
  async function create(entries: Record<string, string>) {
    try {
      await createEventType(form(entries));
    } catch {
      // the redirect the mock throws
    }
    return inserted[0];
  }

  it("sets both buffers from the one gap field", async () => {
    const row = await create({ name: "Consult", gap_min: "10" });
    expect(row).toMatchObject({ buffer_before_min: 10, buffer_after_min: 10 });
  });

  it.each(["-5", "7.5", "9999", "abc"])("refuses a gap of %j and creates nothing", async (gap) => {
    let to = "";
    try {
      await createEventType(form({ name: "Consult", gap_min: gap }));
    } catch (err) {
      to = String((err as Error).message);
    }
    expect(to).toContain("error=");
    expect(insert).not.toHaveBeenCalled();
  });

  it("records the gap it created with in the trail", async () => {
    await create({ name: "Consult", gap_min: "10" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_type.created",
        details: expect.objectContaining({ buffer_before_min: 10, buffer_after_min: 10 }),
      }),
    );
  });

  it("leaves both at the column default when the gap is left blank", async () => {
    const row = await create({ name: "Consult" });
    expect(row).toMatchObject({ buffer_before_min: 0, buffer_after_min: 0 });
  });
});
