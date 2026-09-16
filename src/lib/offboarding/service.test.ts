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
type FakeRow = { id: string; deactivated_at: string | null; auth_user_id?: string | null };
let row: FakeRow | null = null;
/** Successive answers for successive reads, when a test needs the row to change
 *  underneath it (the lost-race case). Falls back to `row` once drained. */
const rowQueue: Array<FakeRow | null> = [];
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

// #2378. The real module talks to the Supabase auth admin API, which no test may
// reach; these stand in for it and mimic its two answers, so a test can drive the
// failure path as well as the success one.
const sessions = vi.hoisted(() => ({
  revokeSupabaseSessions: vi.fn(),
  restoreSupabaseSessions: vi.fn(),
}));
vi.mock("@/lib/auth/session-revoke", () => sessions);

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({
  log: { error: logError, warn: vi.fn(), info: vi.fn() },
}));

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
  logError.mockReset();
  sessions.revokeSupabaseSessions.mockReset();
  sessions.restoreSupabaseSessions.mockReset();
  sessions.revokeSupabaseSessions.mockImplementation(async (id: string | null) =>
    id ? "revoked" : "no-auth-account",
  );
  sessions.restoreSupabaseSessions.mockImplementation(async (id: string | null) =>
    id ? "restored" : "no-auth-account",
  );
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

// #2124: the admin path sweeps when, and only when, the admin ASKED it to.
//
// Dan, 2026-09-09: "can we add a warning asking if they'd like to sweep? that way
// it's a deliberate choice". That answers the objection #1241 recorded for
// refusing the sweep here, which was that consolidating it would "silently start
// moving customers' appointments out from under an admin who was only pausing
// somebody". The objection was about SILENCE, not about the sweep, and a press
// that asks is not silent.
//
// The default is what matters most and it is NOT sweeping: the caller has to say
// so. A boolean that defaults to true would make every existing caller start
// moving appointments the moment it shipped, which is exactly the silent change
// the recorded comment refused.
describe("the admin UI path sweeps only when asked (#2124)", () => {
  it("enqueues nothing when the caller does not ask", async () => {
    row = { id: "u1", deactivated_at: null };
    const res = await applyLifecycleByUserId("u1", "deactivate");
    expect(res).toMatchObject({ status: "applied", deactivate: true });
    expect("coverageSweep" in res).toBe(false);
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  it("enqueues nothing when the caller asks NOT to, which is the leave them choice", async () => {
    row = { id: "u1", deactivated_at: null };
    await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: false });
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  it("sweeps when the admin chose to move the bookings", async () => {
    row = { id: "u1", deactivated_at: null };
    booking.startBulkReassign.mockResolvedValue({ jobId: "job1", itemCount: 3 });

    const res = await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: true });

    expect(res).toMatchObject({ status: "applied", deactivate: true, coverageSweep: "queued" });
    expect(booking.startBulkReassign).toHaveBeenCalledTimes(1);
    const arg = booking.startBulkReassign.mock.calls[0][0];
    // Open ended from the moment they left, the same window the automation uses:
    // everything still ahead of them is theirs no longer.
    expect(arg).toMatchObject({ outUserId: "u1", rangeEndIso: null });
    expect(typeof arg.rangeStartIso).toBe("string");
    expect(arg.offboardingDeactivatedAtIso).toBe(arg.rangeStartIso);
  });

  // The whole point of asking. An admin who chose to move nothing, and one whose
  // agent HELD nothing, must be distinguishable, or the panel cannot say what it
  // did (L11).
  it("reports none, not queued, when the agent held nothing to move", async () => {
    row = { id: "u1", deactivated_at: null };
    booking.startBulkReassign.mockResolvedValue({ jobId: "job1", itemCount: 0 });

    const res = await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: true });
    expect(res).toMatchObject({ coverageSweep: "none" });
  });

  // Same ordering the automation path chose (#1237): the deactivation is what
  // stops the agent being offered for anything NEW, and rolling it back to report
  // a coverage problem would leave them taking fresh bookings, which is worse.
  it("keeps the deactivation and reports the failure when the enqueue throws", async () => {
    row = { id: "u1", deactivated_at: null };
    booking.startBulkReassign.mockRejectedValue(new Error("queue down"));

    const res = await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: true });
    expect(res).toMatchObject({ status: "applied", deactivate: true, coverageSweep: "failed" });
    // And the write really happened, so the agent is out of the pool.
    expect(updates).toHaveLength(1);
  });

  // Reactivating has nothing to sweep by construction, and asking for one must not
  // invent a window: `planOffboardingCoverageSweep` refuses on the action, so this
  // is a check that the flag cannot reach past it.
  it("never sweeps on reactivate, even when asked", async () => {
    row = { id: "u1", deactivated_at: "2026-06-01T00:00:00.000Z" };
    await applyLifecycleByUserId("u1", "reactivate", { sweepCoverage: true });
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  it("sweeps nothing for an id that matched nobody", async () => {
    row = null;
    const res = await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: true });
    expect(res).toMatchObject({ status: "not_found" });
    expect(booking.startBulkReassign).not.toHaveBeenCalled();
  });

  // A repeat press converges on ONE sweep rather than accumulating them, the same
  // way the automation path does: the key is the STORED stamp, so the second call
  // (a no-op transition) keys on the same one.
  it("a second press carries the same idempotency key rather than a new one", async () => {
    row = { id: "u1", deactivated_at: null };
    await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: true });
    const first = booking.startBulkReassign.mock.calls[0][0].offboardingDeactivatedAtIso;

    row = { id: "u1", deactivated_at: first };
    await applyLifecycleByUserId("u1", "deactivate", { sweepCoverage: true });
    const second = booking.startBulkReassign.mock.calls[1][0].offboardingDeactivatedAtIso;

    expect(second).toBe(first);
  });
});

// #2378: deactivation wrote `{ deactivated_at, bookable: false }` and nothing
// else, so the person kept a live Supabase session that middleware refreshed on
// every request. The row write and the revoke are TWO controls and both are
// checked here (L397): a failed revoke must never leave this code reporting that
// access was removed.
describe("deactivation revokes the person's Supabase sessions (#2378)", () => {
  const AUTH = "auth-abc";

  it("revokes, keyed on auth_user_id, on the deactivate transition", async () => {
    row = { id: "u1", deactivated_at: null, auth_user_id: AUTH };

    const res = await applyLifecycleByUserId("u1", "deactivate");

    expect(sessions.revokeSupabaseSessions).toHaveBeenCalledWith(AUTH);
    expect(sessions.restoreSupabaseSessions).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "applied", sessionRevoke: "revoked" });
  });

  it("revokes on the automation path too, which is the one with nobody watching", async () => {
    row = { id: "u9", deactivated_at: null, auth_user_id: AUTH };

    const res = await applyLifecycleByEmail("leaver@trypennie.com", "deactivate");

    expect(sessions.revokeSupabaseSessions).toHaveBeenCalledWith(AUTH);
    expect(res).toMatchObject({ status: "applied", sessionRevoke: "revoked" });
  });

  // The row write and the revoke are two steps with no transaction between them.
  // A crash in the gap leaves the row stamped and the session alive, and the
  // retry sees a no-op flip: if the revoke only ran on the TRANSITION the session
  // would stay alive for ever, with the retry reporting success.
  it("a repeat call on an already deactivated row still revokes, so a crash in the gap converges", async () => {
    row = { id: "u1", deactivated_at: "2026-09-01T00:00:00.000Z", auth_user_id: AUTH };

    const res = await applyLifecycleByUserId("u1", "deactivate");

    expect(res).toMatchObject({ status: "noop" });
    expect(updates).toHaveLength(0);
    expect(sessions.revokeSupabaseSessions).toHaveBeenCalledWith(AUTH);
  });

  // Reactivating must lift it, or a rehire is locked out of a row that reads as
  // perfectly active and nothing on any screen says why.
  it("restores session access on reactivate, and revokes nothing", async () => {
    row = { id: "u1", deactivated_at: "2026-06-01T00:00:00.000Z", auth_user_id: AUTH };

    const res = await applyLifecycleByUserId("u1", "reactivate");

    expect(sessions.restoreSupabaseSessions).toHaveBeenCalledWith(AUTH);
    expect(sessions.revokeSupabaseSessions).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "applied", sessionRevoke: "restored" });
  });

  it("says so separately when the person never signed in, rather than claiming a revoke", async () => {
    row = { id: "u1", deactivated_at: null, auth_user_id: null };

    const res = await applyLifecycleByUserId("u1", "deactivate");

    expect(res).toMatchObject({ status: "applied", sessionRevoke: "no-auth-account" });
  });

  it("revokes nothing for an id that matched nobody", async () => {
    row = null;

    const res = await applyLifecycleByUserId("ghost", "deactivate");

    expect(res).toEqual({ status: "not_found" });
    expect(sessions.revokeSupabaseSessions).not.toHaveBeenCalled();
  });

  // THE FAILURE PATH. Supabase auth is an external API on an offboarding path, so
  // it can refuse, time out, or be misconfigured on the deployment. Three things
  // have to hold at once, and the first is the one this issue is about:
  //
  //  - the result does NOT say access was removed, because the caller records
  //    that word and never looks again;
  //  - the deactivation itself STANDS, because rolling it back to report a
  //    session problem would put the agent back in the routing pool taking new
  //    bookings, and the app layer gate already refuses their session on the very
  //    next request whether or not this call succeeded;
  //  - it is logged at error level with the user, so the failure exists somewhere
  //    a person can find it.
  it("reports a FAILED revoke rather than swallowing it, and keeps the deactivation", async () => {
    row = { id: "u1", deactivated_at: null, auth_user_id: AUTH };
    sessions.revokeSupabaseSessions.mockRejectedValue(new Error("auth admin refused the key"));

    const res = await applyLifecycleByUserId("u1", "deactivate");

    expect(res).toMatchObject({ status: "applied", deactivate: true, sessionRevoke: "failed" });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.deactivated_at).toEqual(expect.any(String));

    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, fields, err] = logError.mock.calls[0] as [
      string,
      Record<string, unknown>,
      unknown,
    ];
    expect(tag).toBe("offboarding");
    expect(String(fields.msg)).toMatch(/session/i);
    expect(fields.user_id).toBe("u1");
    expect(err).toBeInstanceOf(Error);
  });

  it("reports a failed RESTORE too, rather than reactivating silently into a lockout", async () => {
    row = { id: "u1", deactivated_at: "2026-06-01T00:00:00.000Z", auth_user_id: AUTH };
    sessions.restoreSupabaseSessions.mockRejectedValue(new Error("auth admin unreachable"));

    const res = await applyLifecycleByUserId("u1", "reactivate");

    expect(res).toMatchObject({ status: "applied", deactivate: false, sessionRevoke: "failed" });
    expect(logError).toHaveBeenCalledTimes(1);
  });

  // The positive control beside the two failures (L159): the same call with the
  // same row and a working auth API logs nothing and reports the revoke, so the
  // assertions above cannot be passing because every path now reports "failed".
  it("logs nothing and reports the revoke on the healthy path", async () => {
    row = { id: "u1", deactivated_at: null, auth_user_id: AUTH };

    const res = await applyLifecycleByUserId("u1", "deactivate");

    expect(res).toMatchObject({ sessionRevoke: "revoked" });
    expect(logError).not.toHaveBeenCalled();
  });
});
