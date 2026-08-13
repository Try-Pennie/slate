import { describe, it, expect, vi, beforeEach } from "vitest";

// #1435: writing an event type and refreshing what the booker serves are ONE
// operation.
//
// Hit live on 2026-08-12: the description was updated, the database was correct, the
// admin screen showed the new text, and the booker went on serving the old one,
// because the event type rides inside the cached bucket_slots payload the read path
// serves. Editing the row is not the same as serving it.
//
// The cases here are the ones no admin-action test reaches, and each is a decision
// that could plausibly have gone the other way: what happens on zero rows, on a
// database error, and when the invalidation itself fails.

const invalidate = vi.hoisted(() => vi.fn(async () => 7));
/** The update chain: .update(patch, opts).eq("id").eq("org_id") resolves to { error, count }. */
const outcome = vi.hoisted(() => ({
  error: null as { message: string } | null,
  count: 1 as number | null,
}));
const eqCalls = vi.hoisted(() => [] as [string, string][]);
const updateArgs = vi.hoisted(() => [] as unknown[][]);
const chain = vi.hoisted(() => {
  const thenable = {
    eq(col: string, val: string) {
      eqCalls.push([col, val]);
      return thenable;
    },
    then(res: (v: unknown) => unknown) {
      return Promise.resolve(res({ error: outcome.error, count: outcome.count }));
    },
  };
  return thenable;
});
const update = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    updateArgs.push(args);
    return chain;
  }),
);
const from = vi.hoisted(() => vi.fn(() => ({ update })));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: invalidate }));

import { updateEventType } from "./event-type-store";

describe("updateEventType (#1435)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outcome.error = null;
    outcome.count = 1;
    eqCalls.length = 0;
    updateArgs.length = 0;
    invalidate.mockResolvedValue(7);
  });

  it("writes the patch scoped to the org and refreshes what the booker serves", async () => {
    const res = await updateEventType({
      eventTypeId: "et1",
      orgId: "o1",
      patch: { description: "A friendly chat" },
    });
    expect(from).toHaveBeenCalledWith("event_types");
    expect(updateArgs[0]?.[0]).toEqual({ description: "A friendly chat" });
    // Counted exactly, because "did anything change" decides both the caller's
    // message and whether the refresh is needed.
    expect(updateArgs[0]?.[1]).toEqual({ count: "exact" });
    // Tenant scoping: the id alone would let one org edit another's event type.
    expect(eqCalls).toEqual([
      ["id", "et1"],
      ["org_id", "o1"],
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ count: 1, error: null, invalidated: true });
  });

  it("does not refresh anything when the id matched no row this org owns", async () => {
    outcome.count = 0;
    const res = await updateEventType({ eventTypeId: "someone-elses", orgId: "o1", patch: { name: "X" } });
    expect(res.count).toBe(0);
    // Nothing was edited, so nothing is stale, and a mass invalidation costs a full
    // recompute cycle across every bucket.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reports a database error and refreshes nothing", async () => {
    outcome.error = { message: "column does not exist" };
    const res = await updateEventType({ eventTypeId: "et1", orgId: "o1", patch: { duration_min: 45 } });
    expect(res.error?.message).toBe("column does not exist");
    expect(res.count).toBe(0);
    expect(res.invalidated).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // FAILURE PATH: the refresh itself fails. The row is committed and correct, so
  // failing the admin's save would leave them re-submitting a change that already
  // landed. It is reported rather than assumed, and the served copy still converges
  // as rows age past the freshness window.
  it("still reports the save when the refresh fails, and says the refresh did not happen", async () => {
    invalidate.mockRejectedValue(new Error("bucket_slots write failed"));
    const res = await updateEventType({ eventTypeId: "et1", orgId: "o1", patch: { name: "Consult" } });
    expect(res.error).toBeNull();
    expect(res.count).toBe(1);
    expect(res.invalidated).toBe(false);
  });

  // A null count with no error is not a measurement of zero. Scoring it as zero
  // would skip the refresh on a write that may well have landed, which is the
  // original defect arriving by a different door.
  it("refreshes when the count could not be measured, rather than assuming nothing changed", async () => {
    outcome.count = null;
    const res = await updateEventType({ eventTypeId: "et1", orgId: "o1", patch: { min_notice_min: 60 } });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(res.invalidated).toBe(true);
  });

  it("refreshes for a duration change too, which the org hours gate reads when judging fit", async () => {
    await updateEventType({ eventTypeId: "et1", orgId: "o1", patch: { duration_min: 60 } });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
