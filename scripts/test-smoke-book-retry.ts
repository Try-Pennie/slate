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
//
// Real ISO stamps at the real 10 minute cadence, not opaque labels (#1491). The
// retry now advances by TIME rather than to the adjacent index, because the next
// slot along sits inside the 20 minute window just attempted: when the conflict is
// residue from a just-cancelled event, retrying 10 minutes later re-reads the same
// busy period and spends the attempt budget without moving. Opaque labels cannot
// exercise that at all, so the fixture has to carry the shape the code reads (L48).
const SLOT_STEP_MS = 10 * 60_000;
const SLOT_BASE_MS = Date.parse("2026-09-01T13:00:00.000Z");
/** 24 slots, four hours, so an hourly stride has somewhere to go. */
const SLOTS = Array.from({ length: 24 }, (_, i) =>
  new Date(SLOT_BASE_MS + i * SLOT_STEP_MS).toISOString(),
);
/** The slot at a given 10 minute offset, for readable assertions. */
const at = (i: number): string => SLOTS[i]!;
/** Minutes between two slots, for a readable failure message. */
const gapMins = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 60_000);

// First slot conflicts (residue of a just-cancelled event), the next one it tries
// is free. The retry must land a full margin later, NOT on the adjacent slot that
// overlaps the window it just failed on.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(SLOTS, 0, async (slot) => {
    tried.push(slot);
    return slot === at(0)
      ? { status: 409, body: { code: "SLOT_TAKEN" as const } }
      : { status: 200, body: { outcome: "created" as const } };
  });
  eq(res.status, 200, "advances past a busy slot to a fresh one and returns created");
  eq(tried.length, 2, "tried the residue slot, then one more");
  eq(tried[0], at(0), "started on the slot it was given");
  assert(
    gapMins(tried[0]!, tried[1]!) >= 60,
    `the retry is a full hour clear of the failed attempt (got ${gapMins(tried[0]!, tried[1]!)} min)`,
  );
}

// A clean first slot returns immediately without touching later slots.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(SLOTS, 5, async (slot) => {
    tried.push(slot);
    return { status: 200, body: { outcome: "created" as const } };
  });
  eq(res.status, 200, "a free first slot returns created");
  eq(tried.join(","), at(5), "does not advance when the first slot is accepted");
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
  eq(tried.join(","), at(5), "confirm_required is NOT retried onto another slot");
}

// Exhausting the attempt budget returns the last conflict so the CALLER's check
// fails loudly (fail-loud), rather than hanging or masking the problem.
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(
    SLOTS,
    0,
    async (slot) => {
      tried.push(slot);
      return { status: 409, body: { code: "SLOT_TAKEN" as const } };
    },
    3,
  );
  eq(res.status, 409, "persistent conflict surfaces the last 409 (fails loudly)");
  eq(tried.length, 3, "stops after maxAttempts and does not loop forever");
  // Every attempt a margin apart, so three attempts really cover three distinct
  // windows rather than three reads of one busy period.
  for (let i = 1; i < tried.length; i++) {
    assert(
      gapMins(tried[i - 1]!, tried[i]!) >= 60,
      `attempt ${i} is a full hour clear of attempt ${i - 1} (got ${gapMins(tried[i - 1]!, tried[i]!)} min)`,
    );
  }
}

// Running out of slots before the budget stops cleanly (no undefined-slot call).
{
  const tried: string[] = [];
  const res = await bookFirstFreeSlot(
    SLOTS,
    SLOTS.length - 2, // nothing an hour past these two
    async (slot) => {
      tried.push(slot);
      return { status: 409, body: { code: "SLOT_TAKEN" as const } };
    },
    5,
  );
  eq(res.status, 409, "returns the last conflict when the slot list is exhausted");
  eq(tried.join(","), at(SLOTS.length - 2), "stops rather than attempting a slot too close to the last");
  assert(
    !tried.includes("undefined"),
    "never attempts a slot past the end of the list",
  );
}

// --- an absorbed conflict is REPORTED, not silently swallowed (#1491, L77) ---
//
// The retry classifies SLOT_TAKEN / NO_ELIGIBLE_AGENTS as expected and moves on. A
// run that retried nine times then reads exactly like one that retried none, so the
// callback is what makes rising contention visible at all.
{
  const seen: { slot: string; code: string | undefined; attempt: number }[] = [];
  const res = await bookFirstFreeSlot(
    SLOTS,
    0,
    async (slot) =>
      slot === at(0)
        ? { status: 409, body: { code: "SLOT_TAKEN" as const } }
        : { status: 200, body: { outcome: "created" as const } },
    4,
    undefined,
    (info) => seen.push(info),
  );
  eq(res.status, 200, "the booking still succeeds");
  eq(seen.length, 1, "the one absorbed conflict is reported exactly once");
  eq(seen[0]!.code, "SLOT_TAKEN", "and carries the code, so the cause is named");
  eq(seen[0]!.slot, at(0), "and the slot it happened on");
}
{
  // A clean first attempt reports nothing, so the signal means what it says.
  const seen: unknown[] = [];
  await bookFirstFreeSlot(
    SLOTS,
    0,
    async () => ({ status: 200, body: { outcome: "created" as const } }),
    4,
    undefined,
    (info) => seen.push(info),
  );
  eq(seen.length, 0, "a clean run reports no absorbed conflicts");
}
{
  // A functional confirm_required is not a conflict and must not be counted as one.
  const seen: unknown[] = [];
  await bookFirstFreeSlot(
    SLOTS,
    0,
    async () => ({ status: 409, body: { outcome: "confirm_required" as const } }),
    4,
    undefined,
    (info) => seen.push(info),
  );
  eq(seen.length, 0, "confirm_required is not counted as an absorbed slot conflict");
}

finish();
