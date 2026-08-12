import { describe, it, expect, vi, beforeEach } from "vitest";

// #1335: the setEventDescription admin action, which is what makes the copy a lead
// reads before booking editable without a deploy.
//
// The failure paths are the point here. A save that redirected to a cheerful "ok"
// having written nothing would leave the OLD copy in front of every lead while
// telling the author it had changed (L12), and there are two ways to write nothing:
// the update errors, or it matches no row because the id belongs to another org.
// Both are pinned, in both directions, along with the tenant scoping that makes the
// second case possible at all.
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
const from = vi.hoisted(() => vi.fn(() => ({ update })));
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

import { setEventDescription } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  updateArgs.length = 0;
  result.error = null;
  result.count = 1;
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

const DANS_COPY =
  "Twenty minutes with a senior advisor to confirm your income, then review the terms " +
  "and rates you may qualify for.\n\nA small ask: join from somewhere quiet, not while " +
  "driving, with access to a screen (phone, tablet, laptop, etc.).";

/** The action always ends in a redirect, which the mock throws. */
async function run(entries: Record<string, string>): Promise<string> {
  try {
    await setEventDescription(form(entries));
  } catch (err) {
    return String((err as Error).message).replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action returned without redirecting");
}

describe("setEventDescription", () => {
  it("is admin only", async () => {
    auth.requireAdmin.mockRejectedValue(new Error("nope"));
    await expect(setEventDescription(form({ event_type_id: "et1", description: "x" }))).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("saves the copy and scopes the write to the admin's own org", async () => {
    const to = await run({ event_type_id: "et1", description: DANS_COPY });
    expect(to).toBe("/admin/settings?ok=1");
    expect(updateArgs[0]).toEqual({ description: DANS_COPY });
    // Both filters, or an admin could edit another org's copy by guessing an id.
    expect(eqCalls).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
    ]);
    expect(recordAudit).toHaveBeenCalled();
    // The description rides in the cached slots payload, so the served copy is
    // converged now rather than only as rows age.
    expect(markAllBucketSlotsStale).toHaveBeenCalled();
  });

  it("clears the description when the field is left blank", async () => {
    await run({ event_type_id: "et1", description: "   \n " });
    // null, not "": an empty string would leave the booker rendering an empty panel.
    expect(updateArgs[0]).toEqual({ description: null });
  });

  it("refuses an over-long description without writing anything", async () => {
    const to = await run({ event_type_id: "et1", description: "x".repeat(5000) });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a request that names no event type", async () => {
    const to = await run({ description: DANS_COPY });
    expect(to).toContain("error=");
    expect(update).not.toHaveBeenCalled();
  });

  // The failure path this test file exists for. A write that errored and still
  // redirected to ok=1 would tell the author their copy had changed while every
  // lead kept reading the old one.
  it("tells the author when the write itself failed, and claims nothing", async () => {
    result.error = { message: "connection lost" };
    const to = await run({ event_type_id: "et1", description: DANS_COPY });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=1");
    expect(recordAudit).not.toHaveBeenCalled();
    // And it does not invalidate every bucket over a save that did not happen.
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  // The other way to write nothing, which no error reports: the id matched no row
  // this org owns. Indistinguishable from success on the error field alone.
  it("tells the author when the save matched no row of theirs", async () => {
    result.count = 0;
    const to = await run({ event_type_id: "someone-elses", description: DANS_COPY });
    expect(to).toContain("error=");
    expect(to).not.toContain("ok=1");
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // Both directions, or an action wired to redirect to an error every time would
  // pass all three failure tests above (L1).
  it("still reports success on a save that really wrote a row", async () => {
    result.count = 1;
    expect(await run({ event_type_id: "et1", description: DANS_COPY })).toBe("/admin/settings?ok=1");
  });
});
