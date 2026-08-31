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
//
// #1239 landed on the same function: it hands the caller back the ROWS it
// snapshotted, so the manager's notice can say what is moving and name the
// appointments starting within the next couple of hours. The two changes met in one
// function, and a resolution keeping only one of them would still typecheck and
// still pass everything else, because the offboarding cases below never look at the
// snapshot and the notice suites never enqueue an offboarding sweep. So both halves
// are asserted here, together, on both the ordinary and the conflict path.

type Row = Record<string, unknown>;

const calls = {
  inserted: [] as Row[],
  jobLookupFilters: [] as Array<[string, unknown]>,
  itemsUpserted: [] as Row[][],
  reactivated: [] as string[],
  /** The filter columns of each bulk_reassign_items UPDATE, so the re-arm's own
   *  conditions are visible rather than inferred (#1665). */
  itemsUpdated: [] as string[][],
};
/** Postgres unique violation, i.e. this sweep already exists. */
let insertConflicts = false;
let existingJob: { id: string } | null = null;
/** What the snapshot query reads: the ids the items are made from, plus the fields
 *  the manager's notice describes each appointment with (#1239). */
let snapshotRows: Array<{
  id: string;
  starts_at: string;
  ends_at: string;
  attendee_name: string | null;
}> = [];
const SNAPSHOT: typeof snapshotRows = [
  { id: "bk1", starts_at: "2026-09-01T14:00:00Z", ends_at: "2026-09-01T14:30:00Z", attendee_name: "Jane" },
  { id: "bk2", starts_at: "2026-09-01T16:00:00Z", ends_at: "2026-09-01T16:30:00Z", attendee_name: null },
];

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
  self.range = async () => ({ data: snapshotRows, error: null });
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
  // An update chain that can carry more than one filter, because the re-arm of
  // items a cancellation stopped (#1665) is update -> eq(job) -> in(bookings) ->
  // eq(status) and answers with a count. Thenable so it resolves at whatever point
  // the caller awaits it.
  self.update = () => {
    const filters: Array<[string, unknown]> = [];
    const upd: Record<string, unknown> = {};
    upd.eq = (col: string, val: unknown) => {
      filters.push([col, val]);
      return upd;
    };
    upd.in = () => upd;
    upd.then = (resolve: (value: { error: null; count: number }) => void) => {
      const id = filters.find(([col]) => col === "id");
      if (table === "bulk_reassign_jobs" && id) calls.reactivated.push(String(id[1]));
      if (table === "bulk_reassign_items") calls.itemsUpdated.push(filters.map(([c]) => c));
      resolve({ error: null, count: 0 });
    };
    return upd;
  };
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
  calls.itemsUpdated.length = 0;
  insertConflicts = false;
  existingJob = null;
  snapshotRows = [...SNAPSHOT];
});

describe("an offboarding coverage sweep is keyed on the deactivation (#1241)", () => {
  it("stamps the deactivation on the job row, so the unique index has something to bite on", async () => {
    const res = await createBulkReassignJob(offboardingInput);

    expect(res).toEqual({ jobId: "job-new", itemCount: 2, snapshot: SNAPSHOT });
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
    // And the rows come back out of the conflict branch as well, which returns
    // through different code than the ordinary one. This is the half a merge could
    // drop in silence: everything above would still pass (#1239).
    expect(res.snapshot).toEqual(SNAPSHOT);
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

  it("describes the work whatever the sweep is keyed on", async () => {
    const res = await createBulkReassignJob({
      ...offboardingInput,
      createdBy: "mgr1",
      offboardingDeactivatedAtIso: null,
      oooRequestId: "req1",
      rangeEndIso: "2026-09-01T21:00:00Z",
    });

    expect(calls.inserted[0]).toMatchObject({ ooo_request_id: "req1" });
    // The notice reads these: a time and an attendee per appointment, not just a
    // count, so it can name the one starting within the next couple of hours.
    expect(res.snapshot).toEqual(SNAPSHOT);
  });
});
