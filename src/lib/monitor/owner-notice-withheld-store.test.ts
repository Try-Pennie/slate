import { describe, it, expect } from "vitest";
import { countWithheldOwnerNotices } from "./owner-notice-withheld-store";

// #2440: the count the weekly withheld notice report reads. It must ask for exactly
// the step the notice handler marks, as a server side count, and must THROW on a
// failed read rather than report a week with nothing withheld.

function fakeDb(answer: { count: number | null; error: { message: string } | null }) {
  const calls: { table?: string; select?: unknown[]; gte?: unknown[]; filter?: unknown[] } = {};
  const chain = {
    select: (...args: unknown[]) => {
      calls.select = args;
      return chain;
    },
    gte: (...args: unknown[]) => {
      calls.gte = args;
      return chain;
    },
    filter: (...args: unknown[]) => {
      calls.filter = args;
      return Promise.resolve(answer);
    },
  };
  const db = {
    from: (table: string) => {
      calls.table = table;
      return chain;
    },
  };
  return { db: db as never, calls };
}

describe("countWithheldOwnerNotices (#2440)", () => {
  it("counts outbox rows whose owner notice step was withheld for want of a channel", async () => {
    const { db, calls } = fakeDb({ count: 3, error: null });
    expect(await countWithheldOwnerNotices(db, "2026-10-09T15:00:00.000Z")).toBe(3);
    expect(calls.table).toBe("booking_outbox");
    expect(calls.select).toEqual(["id", { count: "exact", head: true }]);
    expect(calls.gte).toEqual(["created_at", "2026-10-09T15:00:00.000Z"]);
    expect(calls.filter?.[0]).toBe("steps");
    expect(calls.filter?.[1]).toBe("cs");
    expect(JSON.parse(String(calls.filter?.[2]))).toEqual([
      { name: "reassign:owner_notice", withheld: "no_handoff_channel" },
    ]);
  });

  it("THROWS on a failed count, so an unreadable week is never reported as none", async () => {
    const { db } = fakeDb({ count: null, error: { message: "statement timeout" } });
    await expect(countWithheldOwnerNotices(db, "2026-10-09T15:00:00.000Z")).rejects.toThrow(/statement timeout/);
  });
});
