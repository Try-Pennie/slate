import { describe, it, expect } from "vitest";
import { loadRecentOwnerAlerts } from "./owner-alert-skips-store";

// #2436: the week's owner alerts, read for the skip share. Bounded, by created_at,
// and a failed read THROWS rather than reading as a week with no skips.

function fakeDb(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Record<string, unknown[]> = {};
  const chain = {
    select: (...a: unknown[]) => ((calls.select = a), chain),
    gte: (...a: unknown[]) => ((calls.gte = a), chain),
    order: (...a: unknown[]) => ((calls.order = a), chain),
    limit: (...a: unknown[]) => ((calls.limit = a), Promise.resolve(answer)),
  };
  const db = { from: (t: string) => ((calls.from = [t]), chain) };
  return { db: db as never, calls };
}

describe("loadRecentOwnerAlerts (#2436)", () => {
  it("reads the week's alerts, bounded, as user and skip reason", async () => {
    const { db, calls } = fakeDb({
      data: [
        { user_id: "u1", skip_reason: null },
        { user_id: "u2", skip_reason: "not-provisioned" },
      ],
      error: null,
    });
    expect(await loadRecentOwnerAlerts(db, "2026-10-09T15:00:00.000Z", 1000)).toEqual([
      { userId: "u1", skipReason: null },
      { userId: "u2", skipReason: "not-provisioned" },
    ]);
    expect(calls.from).toEqual(["owner_alert_events"]);
    expect(calls.select).toEqual(["user_id, skip_reason"]);
    expect(calls.gte).toEqual(["created_at", "2026-10-09T15:00:00.000Z"]);
    expect(calls.limit).toEqual([1000]);
  });

  it("THROWS on a failed read, so an unreadable week is never a week with no skips", async () => {
    const { db } = fakeDb({ data: null, error: { message: "permission denied" } });
    await expect(loadRecentOwnerAlerts(db, "2026-10-09T15:00:00.000Z", 1000)).rejects.toThrow(/permission denied/);
  });
});
