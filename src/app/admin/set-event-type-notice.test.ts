import { describe, it, expect, vi, beforeEach } from "vitest";

// setEventTypeNotice: how far ahead of now the earliest offered time can be
// (#3003). It could only be set when an event type was created, so the live
// call type kept a 2 hour notice while cal.com let a lead book a few minutes
// out (Dan, 2026-10-02: "at least 5 minute in the future").
//
// The failure paths matter as much as the save. A redirect saying "saved" over a
// write that errored or matched nothing would leave leads unable to book the
// next hour while the admin believed it was open (L12).
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
/** The read of the current notice, for the audit's old value. */
const current = vi.hoisted(() => ({
  row: { min_notice_min: 120 } as Record<string, number> | null,
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

import { setEventTypeNotice } from "./actions";
import { refusedQuery } from "@/lib/admin/save-outcomes";
import { CHANGED_SINCE_OPENED, PAGE_OUT_OF_DATE } from "@/lib/admin/edit-version";

/** The version the editor was drawn from (#3122). */
const LOADED = "2026-10-03T10:00:00.123456+00:00";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  // #3122: the version the editor was drawn from; a case removes it to test the refusal.
  fd.set("loaded_updated_at", LOADED);
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
  current.row = { min_notice_min: 120 };
  current.error = null;
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

/** The action always ends in a redirect, which the mock throws. */
async function run(entries: Record<string, string>): Promise<string> {
  try {
    await setEventTypeNotice(form(entries));
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

describe("setEventTypeNotice", () => {
  it("is admin only", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("nope"));
    await expect(setEventTypeNotice(form({ event_type_id: "et1", min_notice_min: "5" }))).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("sets the notice, scoped to the admin's org, and refreshes what the booker serves", async () => {
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toBe("/admin/event-types?ok=event-type-notice");
    expect(updateArgs[0]).toEqual({ min_notice_min: 5 });
    expect(eqCalls).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
      ["updated_at", LOADED],
    ]);
    // The cached slots were computed under the old notice, so a shorter one
    // offers nothing new near now until they rebuild.
    expect(markAllBucketSlotsStale).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_type.notice",
        details: expect.objectContaining({
          event_type_id: "et1",
          from: { min_notice_min: 120 },
          to: { min_notice_min: 5 },
        }),
      }),
    );
  });

  it("accepts zero", async () => {
    await run({ event_type_id: "et1", min_notice_min: "0" });
    expect(updateArgs[0]).toEqual({ min_notice_min: 0 });
  });

  it.each(["", "abc", "-5", "7.5", "1441"])("refuses %j without writing anything", async (notice) => {
    const to = await run({ event_type_id: "et1", min_notice_min: notice });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no event type", async () => {
    const to = await run({ min_notice_min: "5" });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
  });

  it("tells the admin when the write itself failed, and claims nothing", async () => {
    result.error = { message: "connection lost" };
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("tells the admin when the call type is not one of theirs", async () => {
    current.row = null;
    const to = await run({ event_type_id: "someone-elses", min_notice_min: "5" });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("tells the admin when the save matched no row", async () => {
    result.count = 0;
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=");
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // #3122: the row is there (the read answers it) but held another version, so
  // another admin saved first. Said as that, and nothing is refreshed or audited.
  it("tells the admin somebody else saved since they opened the page", async () => {
    result.count = 0;
    const to = await run({ event_type_id: "et1", min_notice_min: "5" });
    expect(to).toBe(`/admin/event-types${refusedQuery(CHANGED_SINCE_OPENED)}`);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a form that carried no version, before writing anything", async () => {
    const to = await run({ event_type_id: "et1", min_notice_min: "5", loaded_updated_at: "" });
    expect(to).toBe(`/admin/event-types${refusedQuery(PAGE_OUT_OF_DATE)}`);
    expect(update).not.toHaveBeenCalled();
  });
});
