import { describe, it, expect, vi, beforeEach } from "vitest";

// #1241: an offboarding sweep is made idempotent by a unique index on
// (out_user_id, offboarding_deactivated_at), the same shape #1235 gave the
// time-off sweeps on (request, window). A unique index only bites if the code
// STAMPS the column on the way in and, on the 23505 that index raises, looks the
// existing sweep up by the same pair. Get either half wrong and the second call
// creates a second sweep, or throws, and nothing in the pure enqueue layer can
// see it: that layer is deliberately key-agnostic.
//
// Supabase is mocked, so this is vitest rather than a node script.

type Row = Record<string, unknown>;

const calls = {
  inserted: [] as Row[],
  jobLookupFilters: [] as Array<[string, unknown]>,
  itemsUpserted: [] as Row[][],
  reactivated: [] as string[],
};
/** Postgres unique violation, i.e. this sweep already exists. */
let insertConflicts = false;
let existingJob: { id: string } | null = null;
let snapshotIds: string[] = ["bk1", "bk2"];

function chain(table: string) {
  const self: Record<string, unknown> = {};
  const passthrough = (...names: string[]) => {
    for (const n of names) self[n] = () => self;
  };
  passthrough("select", "in", "gt", "lt", "order", "not", "is");

  self.eq = (col: string, val: unknown) => {
    if (table === "bulk_reassign_jobs") calls.jobLookupFilters.push([col, val]);
    return self;
  };
  self.range = async () => ({ data: snapshotIds.map((id) => ({ id })), error: null });
  self.maybeSingle = async () => ({ data: existingJob, error: null });
  self.single = async () =>
    insertConflicts
      ? { data: null, error: { code: "23505", message: "duplicate key value" } }
      : { data: { id: "job-new" }, error: null };
  self.insert = (row: Row) => {
    calls.inserted.push(row);
    return self;
  };
  self.upsert = (rows: Row[]) => {
    calls.itemsUpserted.push(rows);
    return { select: async () => ({ data: rows.map((_, i) => ({ id: `item${i}` })), error: null }) };
  };
  self.update = () => ({
    eq: async (_col: string, val: string) => {
      calls.reactivated.push(val);
      return { error: null };
    },
  });
  return self;
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: (table: string) => chain(table) }),
}));

import { createBulkReassignJob } from "./bulk-reassign-store";

const DEACTIVATED_AT = "2026-08-31T09:00:00.000Z";

const offboardingInput = {
  orgId: "org1",
  outUserId: "u9",
  rangeStartIso: DEACTIVATED_AT,
  rangeEndIso: null,
  reasonCode: "coverage",
  reasonDetail: null,
  createdBy: null,
  actingAsUserId: null,
  offboardingDeactivatedAtIso: DEACTIVATED_AT,
};

beforeEach(() => {
  calls.inserted.length = 0;
  calls.jobLookupFilters.length = 0;
  calls.itemsUpserted.length = 0;
  calls.reactivated.length = 0;
  insertConflicts = false;
  existingJob = null;
  snapshotIds = ["bk1", "bk2"];
});

describe("an offboarding coverage sweep is keyed on the deactivation (#1241)", () => {
  it("stamps the deactivation on the job row, so the unique index has something to bite on", async () => {
    const res = await createBulkReassignJob(offboardingInput);

    expect(res).toEqual({ jobId: "job-new", itemCount: 2 });
    expect(calls.inserted[0]).toMatchObject({
      out_user_id: "u9",
      offboarding_deactivated_at: DEACTIVATED_AT,
      // No human actor, and no time-off request either: this sweep's whole
      // accountability record is the column above.
      created_by: null,
      ooo_request_id: null,
      range_end: null,
      reason_code: "coverage",
    });
  });

  // The second call for the same deactivation. The insert loses to the unique
  // index, and the conflict path must find the sweep that already exists rather
  // than creating a second one or reporting a failure.
  it("converges onto the existing sweep when the same deactivation is enqueued twice", async () => {
    insertConflicts = true;
    existingJob = { id: "job-existing" };

    const res = await createBulkReassignJob(offboardingInput);

    expect(res.jobId).toBe("job-existing");
    // Looked up by the pair the index is on, not by the time-off key.
    expect(calls.jobLookupFilters).toContainEqual(["out_user_id", "u9"]);
    expect(calls.jobLookupFilters).toContainEqual([
      "offboarding_deactivated_at",
      DEACTIVATED_AT,
    ]);
    expect(calls.jobLookupFilters.some(([col]) => col === "ooo_request_id")).toBe(false);
    // Re-snapshotted rather than merely refused, so a half-written first attempt
    // (job row inserted, items not) still ends up with its work (#1235).
    expect(calls.itemsUpserted[0].map((r) => r.booking_id)).toEqual(["bk1", "bk2"]);
    expect(calls.reactivated).toEqual(["job-existing"]);
  });

  // The failure path of the conflict path. The index said a row exists; if the
  // lookup cannot find it, reporting success would be exactly the amnesiac
  // half-write #1235 removed.
  it("throws rather than reporting success when the conflicting sweep cannot be found", async () => {
    insertConflicts = true;
    existingJob = null;

    await expect(createBulkReassignJob(offboardingInput)).rejects.toThrow(/conflicted/);
  });

  it("leaves the column null for a sweep a person started", async () => {
    await createBulkReassignJob({
      ...offboardingInput,
      createdBy: "admin1",
      offboardingDeactivatedAtIso: null,
    });

    expect(calls.inserted[0]).toMatchObject({
      offboarding_deactivated_at: null,
      created_by: "admin1",
    });
  });
});
