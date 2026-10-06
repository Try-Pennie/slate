// #3265: the reschedule commit's arguments to `commit_reschedule` (migration 0171), and
// how its answer is read.
//
// The move used to be a plain gated UPDATE built from the patch. It is now one database
// call that also writes the outbox work, so the patch is mapped onto the function's
// named arguments. Two things can go wrong there and both are silent: a field the
// function needs arriving empty (the move would write a null where a time was meant),
// and the trace rule (a move that keeps the advisor must LEAVE the stored trace, not
// overwrite it with null). And the answer has three readings that must stay apart: an
// outbox id (the move applied), null (the guard matched nothing), and a refused call,
// which is a write failure and never a lost race (#2373).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reschedule-commit-args.ts
import { commitRescheduleArgs, readCommitReschedule } from "../src/lib/booking/reschedule-commit.ts";
import { BookingWriteFailedError } from "../src/lib/booking/gated-write.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const patch = {
  starts_at: "2026-06-09T14:00:00.000Z",
  ends_at: "2026-06-09T14:30:00.000Z",
  assigned_user_id: "b",
  agent_name: "Bee",
  agent_email: "b@x.com",
  status: "rescheduled" as const,
  gcal_event_id: "slate-evt-2",
  reschedule_seq: 3,
};
const guard = { assignedUserId: "a", gcalEventId: "gcal-old" };
const outbox = { steps: [{ name: "move_slot", state: "pending" as const }], payload: { reasonCode: "rr" } };

{
  const args = commitRescheduleArgs("bk1", patch, guard, outbox);
  eq(args.p_booking_id, "bk1", "the booking");
  eq(`${args.p_guard_assigned} ${args.p_guard_event}`, "a gcal-old", "the guard is the assignee and event the caller read");
  eq(`${args.p_starts_at} ${args.p_ends_at}`, `${patch.starts_at} ${patch.ends_at}`, "the new times");
  eq(`${args.p_assigned_user_id} ${args.p_agent_name} ${args.p_agent_email}`, "b Bee b@x.com", "the advisor it moves to");
  eq(`${args.p_gcal_event_id} ${args.p_reschedule_seq}`, "slate-evt-2 3", "the event and the ordinal");
  assert(args.p_steps === outbox.steps && args.p_payload === outbox.payload, "and the outbox work, as built");
  eq(args.p_set_routing_trace, false, "a move with no trace in its patch leaves the stored trace alone");
  eq(args.p_routing_trace, null, "rather than writing a null over it");
}

{
  const trace = { requestedBucketCode: "112" } as unknown as Record<string, unknown>;
  const args = commitRescheduleArgs("bk1", { ...patch, routing_trace: trace }, guard, outbox);
  eq(args.p_set_routing_trace, true, "a move to another advisor writes its trace");
  assert(args.p_routing_trace === trace, "the trace it was given");
  const nulls = commitRescheduleArgs("bk1", patch, { assignedUserId: null, gcalEventId: null }, outbox);
  eq(`${nulls.p_guard_assigned} ${nulls.p_guard_event}`, "null null", "a guard on an empty assignee or event is passed as null, which the function matches with IS NOT DISTINCT FROM");
}

{
  for (const missing of ["starts_at", "ends_at", "assigned_user_id", "gcal_event_id", "reschedule_seq"] as const) {
    const broken = { ...patch } as Record<string, unknown>;
    delete broken[missing];
    let threw = "";
    try {
      commitRescheduleArgs("bk1", broken, guard, outbox);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert(threw.includes(missing), `a patch with no ${missing} is refused by name rather than written as a null (got: ${threw})`);
  }
}

{
  eq(readCommitReschedule({ data: "ob-1", error: null }), "ob-1", "an outbox id means the move applied");
  eq(readCommitReschedule({ data: null, error: null }), null, "null means the guard matched nothing");
  let failed: unknown = null;
  try {
    readCommitReschedule({ data: null, error: { message: "permission denied for function commit_reschedule" } });
  } catch (err) {
    failed = err;
  }
  assert(failed instanceof BookingWriteFailedError && failed.op === "reschedule_commit", "a refused call is a write failure, never read as a lost race (#2373)");
  let odd = "";
  try {
    readCommitReschedule({ data: 42 as unknown as string, error: null });
  } catch (err) {
    odd = err instanceof Error ? err.message : String(err);
  }
  assert(/not an outbox id/.test(odd), `an answer that is neither an id nor null is refused by name, never read as either (got: ${odd})`);
}

finish();
