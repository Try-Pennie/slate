import { describe, it, expect, vi, beforeEach } from "vitest";

// #278: the offboarding service now flips by user id (for the admin UI action)
// as well as by email (for the automation API), sharing one idempotent core.
// The write must set deactivated_at to a timestamp on deactivate and null on
// reactivate, and be a no-op when the row is already in the target state.
// Supabase is mocked; the pure planLifecycleChange is exercised for real.
//
// #1241 added the automatic coverage sweep to the by-email (automation) path, so
// the mock also has to model the compare-and-swap the deactivate write now is: an
// update filtered on the state the plan was made from, returning the row it
// changed, or nothing when somebody else got there first.

const updates: Array<{
  col: string;
  val: string;
  patch: { deactivated_at: string | null; bookable?: boolean };
  filters: Array<[string, string]>;
}> = [];
let row: { id: string; deactivated_at: string | null } | null = null;
/** Successive answers for successive reads, when a test needs the row to change
 *  underneath it (the lost-race case). Falls back to `row` once drained. */
const rowQueue: Array<{ id: string; deactivated_at: string | null } | null> = [];
let lastLookup: { col: string; val: string } | null = null;
let selectError: { message: string } | null = null;
let updateError: { message: string } | null = null;
/** Simulates losing the compare-and-swap: the update matches no row. */
let updateMatchesNothing = false;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (col: string, val: string) => {
          lastLookup = { col, val };
          return {
            maybeSingle: async () => {
              if (selectError) return { data: null, error: selectError };
              const next = rowQueue.length ? rowQueue.shift()! : row;
              return { data: next, error: null };
            },
          };
        },
      }),
      update: (patch: { deactivated_at: string | null; bookable?: boolean }) => {
        const record: (typeof updates)[number] = {
          col: "",
          val: "",
          patch,
          filters: [],
        };
        const chain = {
          eq: (col: string, val: string) => {
            record.col = col;
            record.val = val;
            return chain;
          },
          is: (col: string, val: unknown) => {
            record.filters.push([col, `is ${String(val)}`]);
            return chain;
          },
          not: (col: string, op: string, val: unknown) => {
            record.filters.push([col, `not ${op} ${String(val)}`]);
            return chain;
          },
          select: () => ({
            maybeSingle: async () => {
              updates.push(record);
              if (updateError) return { data: null, error: updateError };
              if (updateMatchesNothing) return { data: null, error: null };
              return { data: { deactivated_at: record.patch.deactivated_at }, error: null };
            },
          }),
        };
        return chain;
      },
    }),
  }),
}));

const booking = vi.hoisted(() => ({ startBulkReassign: vi.fn() }));
vi.mock("@/lib/booking/service", () => booking);

import { applyLifecycleByEmail, applyLifecycleByUserId } from "./service";

beforeEach(() => {
  updates.length = 0;
  rowQueue.length = 0;
  row = null;
  lastLookup = null;
  selectError = null;
  updateError = null;
  updateMatchesNothing = false;
  booking.startBulkReassign.mockReset();
  booking.startBulkReassign.mockResolvedValue({ jobId: "job1", itemCount: 0 });
});

describe("applyLifecycleByUserId", () => {
  it("looks up by id and deactivates an active user (sets a timestamp)", async () => {
    row = { id: "u1", deactivated_at: null };
    const res = await applyLifecycleByUserId("u1", "deactivate");
    expect(res).toMatchObject({ status: "applied", userId: "u1", deactivate: true });
    expect(lastLookup).toEqual({ col: "id", val: "u1" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ col: "id", val: "u1" });
    expect(typeof updates[0].patch.deactivated_at).toBe("string");
  });

  // #1324: offboarding set deactivated_at and nothing else, so a leaver kept
  // users.bookable = true indefinitely. Harmless to routing, which already
  // requires deactivated_at is null, but it makes every COUNT of the bookable pool
  // wrong unless each reader remembers to filter on both columns, and #1297's
  // coverage readout already had to work around it. Measured 2026-08-06: 11 of the
  // 13 flagged rows were leavers, overstating the pool by 11 people.
  it("clears the bookable flag in the same write that deactivates", async () => {
    row = { id: "u1", deactivated_at: null };
    await applyLifecycleByUserId("u1", "deactivate");

    expect(updates).toHaveLength(1);
    expect(updates[0].patch.bookable).toBe(false);
    // One write, not two: a second statement could fail on its own and leave the
    // row half-changed.
    expect(typeof updates[0].patch.deactivated_at).toBe("string");
  });

  // Reactivation deliberately does NOT restore it. Re-admitting somebody to the
  // routing pool is the decision users.bookable exists to make deliberately, and
  // the roster sync already brings new agents in as bookable=false and never
  // re-activates anyone.
  it("leaves the bookable flag alone when reactivating", async () => {
    row = { id: "u1", deactivated_at: "2026-06-01T00:00:00.000Z" };
    await applyLifecycleByUserId("u1", "reactivate");

    expect(updates).toHaveLength(1);
    expect(updates[0].patch.deactivated_at).toBeNull();
    expect("bookable" in updates[0].patch).toBe(false);
  });

  it("reactivates a deactivated user (clears the timestamp)", async () => {
    row = { id: "u1", deactivated_at: "2026-01-01T00:00:00Z" };
    const res = await applyLifecycleByUserId("u1", "reactivate");
    expect(res).toMatchObject({ status: "applied", userId: "u1", deactivate: false });
    expect(updates[0].patch.deactivated_at).toBeNull();
  });

  it("is an idempotent no-op when already in the target state (no write)", async () => {
    row = { id: "u1", deactivated_at: null };
    const res = await applyLifecycleByUserId("u1", "reactivate");
    expect(res).toMatchObject({ status: "noop", userId: "u1" });
    expect(updates).toHaveLength(0);
  });

  it("returns not_found for an unknown id and writes nothing", async () => {
    row = null;
    const res = await applyLifecycleByUserId("ghost", "deactivate");
    expect(res).toEqual({ status: "not_found" });
    expect(updates).toHaveLength(0);
  });
});

// Fail loud. Both reads and the write used to ignore their `error`, so a
// deactivate that never happened returned `status: "applied"`. Everything
// downstream believes that word: the admin page says the agent is deactivated,
// the offboarding automation records the offboarding as done, and the agent keeps
// taking bookings. A silent no-op here is worse than an error, because nobody
// looks again.
describe("a lifecycle write that failed never reports success (#1215)", () => {
  it("throws when the update errors instead of claiming applied", async () => {
    row = { id: "u1", deactivated_at: null };
    updateError = { message: "permission denied for table users" };
    await expect(applyLifecycleByUserId("u1", "deactivate")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("throws when the lookup errors instead of claiming not_found", async () => {
    row = { id: "u1", deactivated_at: null };
    selectError = { message: "column users.deactivated_at does not exist" };
    await expect(applyLifecycleByUserId("u1", "deactivate")).rejects.toThrow(
      /does not exist/,
    );
    expect(updates).toHaveLength(0);
  });

  // Same for the automation path, which is the one with no human watching.
  it("throws on the by-email path too", async () => {
    row = { id: "u9", deactivated_at: null };
    updateError = { message: "deadlock detected" };
    await expect(applyLifecycleByEmail("leaver@trypennie.com", "deactivate")).rejects.toThrow(
      /deadlock detected/,
    );
    // And never enqueues a sweep off a deactivation that did not happen.
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });
});

describe("applyLifecycleByEmail still works through the shared core", () => {
  it("looks up by email and deactivates", async () => {
    row = { id: "u9", deactivated_at: null };
    const res = await applyLifecycleByEmail(" leaver@trypennie.com ", "deactivate");
    expect(res).toMatchObject({ status: "applied", userId: "u9", deactivate: true });
    expect(lastLookup).toEqual({ col: "email", val: "leaver@trypennie.com" });
  });
});

// #1241: a customer kept a confirmed appointment with an advisor who had left,
// until somebody read a Slack message about it an hour later and ran the coverage
// panel by hand. The lifecycle API has no human in it, so it sweeps on its own.
describe("the offboarding API sweeps the departed agent's appointments (#1241)", () => {
  it("enqueues one open-ended coverage sweep on the deactivate transition", async () => {
    row = { id: "u9", deactivated_at: null };
    booking.startBulkReassign.mockResolvedValue({ jobId: "job1", itemCount: 3 });

    const res = await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    expect(booking.startBulkReassign).toHaveBeenCalledTimes(1);
    const args = booking.startBulkReassign.mock.calls[0][0];
    expect(args.outUserId).toBe("u9");
    expect(args.reason).toEqual({ code: "coverage", detail: null });
    // Open ended, from the moment they left.
    expect(args.rangeEndIso).toBeNull();
    expect(args.rangeStartIso).toBe(updates[0].patch.deactivated_at);
    // No human actor, and the record of WHY there is none.
    expect(args.actor).toBeNull();
    expect(args.offboardingDeactivatedAtIso).toBe(updates[0].patch.deactivated_at);
    expect(res).toMatchObject({ status: "applied", coverageSweep: "queued" });
  });

  // #1239 put a coverage line on the time-off manager notice and an edit on the
  // manager's Slack message reporting what moved. Both hang off an ooo_requests
  // row: the notice is addressed to that request's manager of record, and the
  // admin queue's link to a sweep is keyed on `ooo_request_id`.
  //
  // An offboarding sweep has no request and no human anywhere in the call, so it
  // must never carry one. If it did, the notice path would be handed a sweep with
  // nobody to address and a queue row would link to a request that does not exist.
  // Asserted on the enqueue arguments rather than on "no Slack call happened",
  // because a module that never imports Slack cannot call it and a test written
  // that way passes for a reason unrelated to what it claims (L159).
  it("carries no time off request, which is what would pull it into the manager notice path", async () => {
    row = { id: "u9", deactivated_at: null };
    booking.startBulkReassign.mockResolvedValue({ jobId: "job1", itemCount: 2 });

    await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    const args = booking.startBulkReassign.mock.calls[0][0];
    expect(args.oooRequestId ?? null).toBeNull();
    expect(args.actor).toBeNull();
    // And it still says WHY it has no actor, which is the one thing that makes an
    // unattributed sweep legal (#1241).
    expect(typeof args.offboardingDeactivatedAtIso).toBe("string");
  });

  it("reports none, not queued, when the agent held nothing to move", async () => {
    row = { id: "u9", deactivated_at: null };
    booking.startBulkReassign.mockResolvedValue({ jobId: "job1", itemCount: 0 });

    const res = await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    // A measured "nothing to move" reads differently from a failure: one needs no
    // action, the other is retryable.
    expect(res).toMatchObject({ coverageSweep: "none" });
  });

  // Called twice for the same agent. The second call is a no-op flip, and it
  // re-enqueues under the SAME key (the row's stored deactivated_at), which is
  // what lets the unique index on (agent, deactivation) settle both onto one
  // sweep. A key derived from a fresh clock read would mint a second one.
  it("a second call carries the same idempotency key rather than a new one", async () => {
    row = { id: "u9", deactivated_at: null };
    await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    // The retry, some time later, sees the row as the first call left it. The
    // stamp is deliberately NOT "now": a key read off the clock would match the
    // stored one only when both reads land in the same millisecond, which is
    // exactly what a fast test would let through.
    const storedStamp = "2026-08-31T09:00:00.000Z";
    row = { id: "u9", deactivated_at: storedStamp };
    const res = await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    expect(res).toMatchObject({ status: "noop", userId: "u9" });
    // No second write to users: the flip is idempotent.
    expect(updates).toHaveLength(1);
    expect(booking.startBulkReassign).toHaveBeenCalledTimes(2);
    expect(booking.startBulkReassign.mock.calls[1][0].offboardingDeactivatedAtIso).toBe(
      storedStamp,
    );
    expect(booking.startBulkReassign.mock.calls[1][0].rangeStartIso).toBe(storedStamp);
  });

  // The concurrent shape of the same thing. Two calls in flight both read an
  // active row and both plan a deactivation; the compare-and-swap means only one
  // performs it, and the loser keys its sweep on the stamp that is actually
  // STORED rather than on its own.
  it("a lost race keys the sweep on the stored stamp, not on its own", async () => {
    const winnerStamp = "2026-08-31T09:00:00.000Z";
    // The first read is the pre-race row (still active, so this call plans a
    // deactivation); the second is the row as the winner left it.
    rowQueue.push({ id: "u9", deactivated_at: null }, { id: "u9", deactivated_at: winnerStamp });
    updateMatchesNothing = true;

    const res = await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    // The update was filtered on the state the plan was made from. Without that
    // filter both callers would write, the stamp would be whichever landed last,
    // and the two sweeps would carry two different keys.
    expect(updates[0].filters).toContainEqual(["deactivated_at", "is null"]);
    expect(res).toMatchObject({ status: "noop", userId: "u9" });
    expect(booking.startBulkReassign).toHaveBeenCalledTimes(1);
    expect(booking.startBulkReassign.mock.calls[0][0].offboardingDeactivatedAtIso).toBe(
      winnerStamp,
    );
  });

  it("does not sweep on reactivate, so appointments moved while away stay moved", async () => {
    row = { id: "u9", deactivated_at: "2026-06-01T00:00:00.000Z" };
    const res = await applyLifecycleByEmail("rehire@trypennie.com", "reactivate");
    expect(res).toMatchObject({ status: "applied", deactivate: false });
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  it("does not sweep for an email that matched nobody", async () => {
    row = null;
    const res = await applyLifecycleByEmail("ghost@trypennie.com", "deactivate");
    expect(res).toEqual({ status: "not_found" });
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  // The failure path. A coverage failure must not roll back the deactivation:
  // that would leave the agent taking NEW bookings, which is strictly worse. It
  // must also not be swallowed into a clean success.
  it("keeps the deactivation and reports the failure when the enqueue throws", async () => {
    row = { id: "u9", deactivated_at: null };
    booking.startBulkReassign.mockRejectedValue(new Error("could not reach the database"));

    const res = await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    expect(res).toMatchObject({ status: "applied", deactivate: true, coverageSweep: "failed" });
    // The deactivation itself still happened.
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.deactivated_at).toEqual(expect.any(String));
  });
});

// The narrow scope, as a tested invariant rather than a side effect of which
// function happens to call which. An admin deactivating on the agent page keeps
// the confirm step and the coverage panel; only the automated endpoint, which has
// nobody to ask, sweeps on its own.
describe("the admin UI path never auto-sweeps (#1241)", () => {
  it("deactivating by user id enqueues nothing", async () => {
    row = { id: "u1", deactivated_at: null };
    const res = await applyLifecycleByUserId("u1", "deactivate");
    expect(res).toMatchObject({ status: "applied", deactivate: true });
    expect("coverageSweep" in res).toBe(false);
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  it("reactivating by user id enqueues nothing either", async () => {
    row = { id: "u1", deactivated_at: "2026-06-01T00:00:00.000Z" };
    await applyLifecycleByUserId("u1", "reactivate");
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });
});
