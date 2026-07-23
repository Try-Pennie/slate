// Unit test for the smoke-canary slot-reuse fix.
//
// The bug (observed 2026-07-23, run 30010672602): the 6h full booking smoke pass
// reuses a stale slot snapshot across scenarios, and scenarios [4] (lookup/cancel)
// and [6] (reassign) re-booked a slot a PRIOR scenario had just cancelled. A cancel
// deletes the Google event on the happy path, but per #166/#524 it can orphan it,
// and the orphan sweep that would clean that up is deliberately OFF in CI (no SA
// creds on the runner: SMOKE_SKIP_EVENT_CLEANUP=1). verify-on-book reads Google
// LIVE at book time (src/lib/booking/service.ts), so the residual/lagging event
// made the reused slot read busy -> the seed create came back 409 SLOT_TAKEN /
// NO_ELIGIBLE_AGENTS (outcome undefined), failing 4 checks and paging.
//
// The fix: book the first slot the API actually accepts, advancing PAST a transient
// slot conflict onto a fresh slot, so a slot that still holds a just-cancelled
// event's residue is skipped instead of flaking the run. A 409 confirm_required is
// the functional weak-match path and must NOT be retried.
//
// Run: node --experimental-strip-types scripts/test-smoke-book-retry.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { isTransientSlotConflict, bookFirstFreeSlot } from "./lib/smoke-book-retry.ts";

// --- isTransientSlotConflict: only 409 SLOT_TAKEN / NO_ELIGIBLE_AGENTS -----------

assert(
  isTransientSlotConflict({ status: 409, body: { code: "SLOT_TAKEN" } }),
  "409 SLOT_TAKEN is a transient slot conflict",
);
assert(
  isTransientSlotConflict({ status: 409, body: { code: "NO_ELIGIBLE_AGENTS" } }),
  "409 NO_ELIGIBLE_AGENTS is a transient slot conflict",
);
assert(
  !isTransientSlotConflict({ status: 409, body: { outcome: "confirm_required" } }),
  "409 confirm_required is NOT transient (functional weak-match path)",
);
assert(
  !isTransientSlotConflict({ status: 200, body: { outcome: "created" } }),
  "200 created is not a conflict",
);
assert(
  !isTransientSlotConflict({ status: 500, body: {} }),
  "a 500 is not a slot conflict (must fail loudly, not be retried away)",
);

// --- bookFirstFreeSlot: advance past a transient conflict onto a fresh slot -------

const SLOTS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];

// First slot conflicts (residue of a just-cancelled event), next one is free.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(SLOTS, 5, async (slot) => {
    tried.push(slot);
    return slot === "s5"
      ? { status: 409, body: { code: "SLOT_TAKEN" as const } }
      : { status: 200, body: { outcome: "created" as const } };
  });
  eq(res.status, 200, "advances past a busy slot to a fresh one and returns created");
  eq(tried.join(","), "s5,s6", "tried the residue slot then the next fresh slot, in order");
}

// A clean first slot returns immediately without touching later slots.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(SLOTS, 5, async (slot) => {
    tried.push(slot);
    return { status: 200, body: { outcome: "created" as const } };
  });
  eq(res.status, 200, "a free first slot returns created");
  eq(tried.join(","), "s5", "does not advance when the first slot is accepted");
}

// A functional (non-transient) 409 is returned immediately, NEVER retried:
// retrying confirm_required onto a new slot would mask a real behavior.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(SLOTS, 5, async (slot) => {
    tried.push(slot);
    return { status: 409, body: { outcome: "confirm_required" as const } };
  });
  eq(res.body.outcome, "confirm_required", "confirm_required is returned as-is");
  eq(tried.join(","), "s5", "confirm_required is NOT retried onto another slot");
}

// Exhausting the attempt budget returns the last conflict so the CALLER's check
// fails loudly (fail-loud), rather than hanging or masking the problem.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(
    SLOTS,
    5,
    async (slot) => {
      tried.push(slot);
      return { status: 409, body: { code: "SLOT_TAKEN" as const } };
    },
    3,
  );
  eq(res.status, 409, "persistent conflict surfaces the last 409 (fails loudly)");
  eq(tried.length, 3, "stops after maxAttempts and does not loop forever");
}

// Running out of slots before the budget stops cleanly (no undefined-slot call).
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(
    SLOTS,
    6, // only s6, s7 remain
    async (slot) => {
      tried.push(slot);
      return { status: 409, body: { code: "SLOT_TAKEN" as const } };
    },
    5,
  );
  eq(res.status, 409, "returns the last conflict when the slot list is exhausted");
  eq(tried.join(","), "s6,s7", "never attempts a slot past the end of the list");
}

finish();
