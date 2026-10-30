// The unserved placeholder call check's reads (#4206): each one bounded, each one
// filtered to what the check judges, and each one loud on a failure rather than an
// empty answer that would read as "nobody called".
import { describe, expect, it } from "vitest";
import {
  loadCallFeedFirstArrivalAfterMs,
  loadCallFeedNewestReceivedMs,
  loadPlaceholderCallCandidates,
  loadPlaceholderCalls,
  loadProgramLeadBookings,
} from "./placeholder-calls-store";

type Filter = [string, ...unknown[]];

/** A builder that records every query and answers each with the next canned result. */
function fakeDb(results: { data: unknown; error: { message: string } | null }[]) {
  const queries: { table: string; select?: string; filters: Filter[] }[] = [];
  const db = {
    from: (table: string) => {
      const q: { table: string; select?: string; filters: Filter[] } = { table, filters: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      const answer = () => results.shift() ?? { data: [], error: null };
      chain.select = (cols: string) => {
        q.select = cols;
        return chain;
      };
      for (const op of ["eq", "in", "gt", "gte", "lt", "lte", "order", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          q.filters.push([op, ...args]);
          return chain;
        };
      }
      chain.range = () => Promise.resolve(answer());
      chain.maybeSingle = () => Promise.resolve(answer());
      return chain;
    },
  };
  return { db: db as never, queries };
}

describe("loadPlaceholderCallCandidates", () => {
  it("reads placeholder calls in the real buckets, owed statuses only, started in the window", async () => {
    const row = { id: "b1", kind: "staff_placed", status: "completed", starts_at: "s", ends_at: "e", salesforce_id: null, agent_name: null };
    const { db, queries } = fakeDb([{ data: [row], error: null }]);
    expect(await loadPlaceholderCallCandidates(db, ["k1", "k2"], "2026-10-25T19:00:00Z", "2026-10-26T19:00:00Z")).toEqual([row]);
    const q = queries[0]!;
    expect(q.table).toBe("bookings");
    expect(q.filters).toContainEqual(["in", "bucket_id", ["k1", "k2"]]);
    expect(q.filters).toContainEqual(["eq", "kind", "staff_placed"]);
    // A completed booking was owed a call as much as a confirmed one; a cancelled one was not.
    expect(q.filters).toContainEqual(["in", "status", ["confirmed", "rescheduled", "completed"]]);
    expect(q.filters).toContainEqual(["gte", "starts_at", "2026-10-25T19:00:00Z"]);
    expect(q.filters).toContainEqual(["lte", "starts_at", "2026-10-26T19:00:00Z"]);
  });

  it("asks nothing with no real buckets", async () => {
    const { db, queries } = fakeDb([]);
    expect(await loadPlaceholderCallCandidates(db, [], "a", "b")).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("throws on a failed read, never answering no placeholder calls", async () => {
    const { db } = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(loadPlaceholderCallCandidates(db, ["k1"], "a", "b")).rejects.toThrow(/placeholder call candidates/);
  });
});

describe("loadPlaceholderCalls", () => {
  it("reads the Leads' calls since the given start", async () => {
    const call = { id: "c1", lead_key: "00Q5f00000AbCdE", started_at: "2026-10-26T18:05:00Z", is_ai_agent: false };
    const { db, queries } = fakeDb([{ data: [call], error: null }]);
    expect(await loadPlaceholderCalls(db, ["00Q5f00000AbCdE"], "2026-10-26T17:45:00Z")).toEqual([call]);
    expect(queries[0]!.table).toBe("regal_call_outcomes");
    expect(queries[0]!.filters).toContainEqual(["in", "lead_key", ["00Q5f00000AbCdE"]]);
    expect(queries[0]!.filters).toContainEqual(["gte", "started_at", "2026-10-26T17:45:00Z"]);
  });

  it("throws on a failed read, never answering no calls", async () => {
    const { db } = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(loadPlaceholderCalls(db, ["00Q5f00000AbCdE"], "x")).rejects.toThrow(/placeholder calls/);
  });
});

describe("loadCallFeedNewestReceivedMs", () => {
  it("answers the newest arrival in the feed, one row", async () => {
    const { db, queries } = fakeDb([{ data: { received_at: "2026-10-26T18:59:00.000Z" }, error: null }]);
    expect(await loadCallFeedNewestReceivedMs(db)).toBe(Date.UTC(2026, 9, 26, 18, 59));
    expect(queries[0]!.filters).toContainEqual(["order", "received_at", { ascending: false }]);
    expect(queries[0]!.filters).toContainEqual(["limit", 1]);
  });

  it("answers null for an empty feed, which the check reads as an unknown", async () => {
    const { db } = fakeDb([{ data: null, error: null }]);
    expect(await loadCallFeedNewestReceivedMs(db)).toBeNull();
  });

  it("throws on an unreadable stamp rather than guessing the feed alive or dead", async () => {
    const { db } = fakeDb([{ data: { received_at: "not a time" }, error: null }]);
    await expect(loadCallFeedNewestReceivedMs(db)).rejects.toThrow(/unreadable/);
  });

  it("throws on a failed read", async () => {
    const { db } = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(loadCallFeedNewestReceivedMs(db)).rejects.toThrow(/feed newest/);
  });
});

// #4392: the program leads admin page's bookings, and the feed's first arrival after a
// late call was due, which decides whether yesterday's call belongs to today's list.
describe("loadProgramLeadBookings", () => {
  it("reads program bookings in the real buckets, owed statuses only, started in the window, every page", async () => {
    const row = { id: "b1", kind: "routed", status: "confirmed", starts_at: "s", ends_at: "e", salesforce_id: null, agent_name: "Ada", buckets: { is_test: false } };
    const { db, queries } = fakeDb([{ data: [row], error: null }]);
    const { buckets: _b, ...plain } = row;
    expect(await loadProgramLeadBookings(db, "2026-10-16T04:00:00.000Z", "2026-10-30T04:00:00.000Z")).toEqual([plain]);
    const q = queries[0]!;
    expect(q.table).toBe("bookings");
    expect(q.select).toContain("buckets!inner(is_test)");
    expect(q.filters).toContainEqual(["eq", "buckets.is_test", false]);
    expect(q.filters).toContainEqual(["eq", "program_lead", true]);
    expect(q.filters).toContainEqual(["in", "status", ["confirmed", "rescheduled", "completed"]]);
    expect(q.filters).toContainEqual(["gte", "starts_at", "2026-10-16T04:00:00.000Z"]);
    expect(q.filters).toContainEqual(["lt", "starts_at", "2026-10-30T04:00:00.000Z"]);
  });

  it("throws on a failed read, never answering a fortnight with no program bookings", async () => {
    const { db } = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(loadProgramLeadBookings(db, "a", "b")).rejects.toThrow(/program lead bookings/);
  });
});

describe("loadCallFeedFirstArrivalAfterMs", () => {
  it("answers the first arrival at or after the instant, one row", async () => {
    const { db, queries } = fakeDb([{ data: { received_at: "2026-10-26T12:03:00.000Z" }, error: null }]);
    expect(await loadCallFeedFirstArrivalAfterMs(db, "2026-10-26T03:45:00.000Z")).toBe(Date.UTC(2026, 9, 26, 12, 3));
    expect(queries[0]!.table).toBe("regal_call_outcomes");
    expect(queries[0]!.filters).toContainEqual(["gte", "received_at", "2026-10-26T03:45:00.000Z"]);
    expect(queries[0]!.filters).toContainEqual(["order", "received_at", { ascending: true }]);
    expect(queries[0]!.filters).toContainEqual(["limit", 1]);
  });

  it("answers null when nothing has arrived since", async () => {
    const { db } = fakeDb([{ data: null, error: null }]);
    expect(await loadCallFeedFirstArrivalAfterMs(db, "x")).toBeNull();
  });

  it("throws on a failed read or an unreadable stamp", async () => {
    const failed = fakeDb([{ data: null, error: { message: "boom" } }]);
    await expect(loadCallFeedFirstArrivalAfterMs(failed.db, "x")).rejects.toThrow(/first arrival/);
    const garbled = fakeDb([{ data: { received_at: "not a time" }, error: null }]);
    await expect(loadCallFeedFirstArrivalAfterMs(garbled.db, "x")).rejects.toThrow(/unreadable/);
  });
});
