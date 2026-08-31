import { describe, it, expect, vi, beforeEach } from "vitest";

// #1665: the QUERIES that stop a coverage sweep, as opposed to the decision that
// orders them.
//
// `scripts/test-coverage-sweep-cancel.ts` drives the decision and the drain
// against an in-memory store whose writes refuse exactly as the real ones should.
// That proves the design and nothing about whether the shipped statements carry
// those conditions (L3: built is not wired). Every guarantee in this change is a
// WHERE clause, so a missing one would leave the whole suite green while a
// cancellation raced a drain and moved a customer anyway.
//
// So this file asserts the filters, and it asserts them by column and value rather
// than by the query running without error, because a chain missing `.eq("status",
// "pending")` runs perfectly well and updates every row it can see.
//
// Supabase is mocked, so vitest rather than a node script.

type Filter = [string, unknown];

const calls = {
  updates: [] as { table: string; patch: Record<string, unknown>; filters: Filter[] }[],
  selects: [] as { table: string; filters: Filter[]; head: boolean }[],
};

let jobRows: { id: string; status: string }[] = [];
let updateCount = 0;
let selectCount = 0;
let updateError: { message: string } | null = null;

function chain(table: string) {
  const self: Record<string, unknown> = {};
  const filters: Filter[] = [];
  let head = false;

  self.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
    head = opts?.head === true;
    return self;
  };
  self.eq = (col: string, val: unknown) => {
    filters.push([col, val]);
    return self;
  };
  self.in = (col: string, val: unknown) => {
    filters.push([col, val]);
    return self;
  };
  self.update = (patch: Record<string, unknown>) => {
    calls.updates.push({ table, patch, filters });
    return self;
  };
  // Thenable: the caller awaits at the end of whichever chain it built.
  self.then = (resolve: (value: unknown) => void) => {
    const isUpdate = calls.updates.some((u) => u.filters === filters);
    if (isUpdate) {
      resolve({ error: updateError, count: updateError ? null : updateCount });
      return;
    }
    calls.selects.push({ table, filters, head });
    if (head) resolve({ count: selectCount, error: null });
    else resolve({ data: jobRows, error: null });
  };
  return self;
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: (table: string) => chain(table) }),
}));

import { cancelCoverageSweepForRequest } from "./bulk-reassign-store";

const filtersOf = (table: string, statusValue: string) =>
  calls.updates.find(
    (u) => u.table === table && u.filters.some(([c, v]) => c === "status" && v === statusValue),
  );

beforeEach(() => {
  calls.updates.length = 0;
  calls.selects.length = 0;
  jobRows = [{ id: "job1", status: "active" }];
  updateCount = 2;
  selectCount = 3;
  updateError = null;
});

describe("stopping a coverage sweep (#1665)", () => {
  it("finds every sweep the request produced, by the request", async () => {
    await cancelCoverageSweepForRequest("req1");

    const lookup = calls.selects.find((s) => s.table === "bulk_reassign_jobs" && !s.head);
    expect(lookup?.filters).toContainEqual(["ooo_request_id", "req1"]);
  });

  it("stops only the items still WAITING, so one moved a moment ago is untouched", async () => {
    await cancelCoverageSweepForRequest("req1");

    const stop = filtersOf("bulk_reassign_items", "pending");
    // The whole guarantee. Without this filter the update would also rewrite items
    // that had already moved, which #1219 decision 4 says must stay as they are, and
    // would race a drain's own commit with no rule about who wins.
    expect(stop?.filters).toContainEqual(["status", "pending"]);
    expect(stop?.filters).toContainEqual(["job_id", "job1"]);
    expect(stop?.patch).toMatchObject({ status: "cancelled" });
    expect(stop?.patch.detail).toEqual(expect.stringContaining("cancelled"));
  });

  it("stops only a sweep that is still ACTIVE, so a finished one stays done", async () => {
    await cancelCoverageSweepForRequest("req1");

    const job = calls.updates.find((u) => u.table === "bulk_reassign_jobs");
    expect(job?.patch).toMatchObject({ status: "cancelled" });
    expect(job?.filters).toContainEqual(["status", "active"]);
    expect(job?.filters).toContainEqual(["id", "job1"]);
  });

  it("settles the JOB before its items, so a crash between them still converges", async () => {
    await cancelCoverageSweepForRequest("req1");

    const jobIndex = calls.updates.findIndex((u) => u.table === "bulk_reassign_jobs");
    const itemsIndex = calls.updates.findIndex((u) => u.table === "bulk_reassign_items");
    // The other order leaves an ACTIVE sweep with nothing pending, which no lane
    // ever picks up (#1235). This order leaves a cancelled sweep with pending items,
    // and the drain refuses those and records them itself.
    expect(jobIndex).toBeGreaterThanOrEqual(0);
    expect(jobIndex).toBeLessThan(itemsIndex);
  });

  it("reports the counts the database gave it", async () => {
    updateCount = 2;
    selectCount = 3;

    const report = await cancelCoverageSweepForRequest("req1");

    expect(report).toEqual({ jobs: 1, stopped: 2, alreadyMoved: 3 });
    const moved = calls.selects.find((s) => s.head);
    expect(moved?.filters).toContainEqual(["status", "moved"]);
  });

  it("throws rather than reporting a stop it could not make", async () => {
    updateError = { message: "permission denied" };

    // A failure answered as `stopped: 0` would read exactly like a sweep that had
    // nothing left to stop, on the one message telling a manager whether their
    // customers are still being handed over.
    await expect(cancelCoverageSweepForRequest("req1")).rejects.toThrow(/permission denied/);
  });

  it("touches nothing when the request never produced a sweep", async () => {
    jobRows = [];

    const report = await cancelCoverageSweepForRequest("req1");

    expect(report).toEqual({ jobs: 0, stopped: 0, alreadyMoved: 0 });
    expect(calls.updates).toHaveLength(0);
  });
});
