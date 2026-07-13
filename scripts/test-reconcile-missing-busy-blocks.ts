// Reconcile-missing sweep tests (#431): the dangerous counterpart to #428. A
// confirmed/active booking whose busy_block write-through INSERT was missed
// leaves the slot showing FREE in the embed, so it can be DOUBLE-BOOKED on the
// Slate side. reconcileMissingBusyBlocks re-creates the missing slate block for
// any active upcoming booking that lacks one. Safety bias: it ONLY inserts,
// never deletes - a duplicate block (busy) is far safer than a missing one (free).
// Driven through in-memory fakes of BookingDeps (no DB).
// Run: node --experimental-strip-types scripts/test-reconcile-missing-busy-blocks.ts
import {
  reconcileMissingBusyBlocks,
  type ActiveUpcomingBooking,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import type { BusyBlockInsert } from "../src/lib/booking/core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

function booking(id: string, user_id: string): ActiveUpcomingBooking {
  return {
    id,
    user_id,
    starts_at: `2030-01-01T10:00:00.000Z`,
    ends_at: `2030-01-01T10:30:00.000Z`,
  };
}

function makeDeps(opts: { active: ActiveUpcomingBooking[]; haveBlock: string[] }) {
  const inserted: BusyBlockInsert[] = [];
  const calls = {
    loadActiveUpcomingBookings: 0,
    loadBusyBlockBookingIds: [] as string[][],
    // #762: how many WRITES the sweep issued, as opposed to how many rows it wrote.
    insertBatches: 0,
  };
  const deps = {
    loadActiveUpcomingBookings: async (limit: number) => {
      calls.loadActiveUpcomingBookings = limit;
      return opts.active;
    },
    loadBusyBlockBookingIds: async (ids: string[]) => {
      calls.loadBusyBlockBookingIds.push(ids);
      return new Set(opts.haveBlock.filter((id) => ids.includes(id)));
    },
    insertBusyBlocks: async (blocks: BusyBlockInsert[]) => {
      calls.insertBatches++;
      inserted.push(...blocks);
    },
  } as unknown as BookingDeps;
  return { deps, inserted, calls };
}

// --- a booking missing its block gets re-created ---------------------------
{
  // A1/A2 have no block; A3 already has one. A1 + A3 share agent u1.
  const { deps, inserted, calls } = makeDeps({
    active: [booking("A1", "u1"), booking("A2", "u2"), booking("A3", "u1")],
    haveBlock: ["A3"],
  });
  const res = await reconcileMissingBusyBlocks(deps, 100);

  assert(res.recreated === 2, "re-creates a block for each active booking missing one (A1, A2)");
  assert(inserted.length === 2, "exactly two busy_blocks inserted");
  // #762: the sweep scans up to RECONCILE_LIMIT=200 rows, so one write per missing
  // row was up to 200 serial round-trips on the shared every-minute invocation.
  assert(
    calls.insertBatches === 1,
    "#762: the missing blocks go out in ONE batched write, not one write per row",
  );
  assert(
    inserted.every((b) => b.source === "slate" && b.booking_id !== null),
    "inserted blocks are slate-sourced and carry the booking id",
  );
  const a1 = inserted.find((b) => b.booking_id === "A1");
  assert(
    !!a1 && a1.user_id === "u1" && a1.starts_at === "2030-01-01T10:00:00.000Z",
    "the re-created block carries the booking's agent + window",
  );
  assert(
    inserted.find((b) => b.booking_id === "A3") === undefined,
    "a booking that already has a block is NOT re-inserted (no duplicate churn)",
  );
  assert(
    JSON.stringify(res.bookingIds.sort()) === JSON.stringify(["A1", "A2"]),
    "reports the re-created booking ids",
  );
  assert(
    JSON.stringify(res.userIds.sort()) === JSON.stringify(["u1", "u2"]),
    "reports the affected agents, deduped (u1 once though it owns A1+A3)",
  );
}

// --- two missing bookings for the SAME agent dedup to one userId ----------
{
  const { deps, inserted } = makeDeps({
    active: [booking("D1", "u9"), booking("D2", "u9")],
    haveBlock: [],
  });
  const res = await reconcileMissingBusyBlocks(deps, 100);
  assert(
    res.recreated === 2 && inserted.length === 2,
    "both same-agent bookings get their own block",
  );
  assert(
    JSON.stringify(res.userIds) === JSON.stringify(["u9"]),
    "the shared agent is reported once (recompute fans out per agent, not per booking)",
  );
}

// --- fail-safe: a block-lookup read error aborts with ZERO inserts --------
{
  // The safety-critical branch: if we can't tell which bookings have blocks, we
  // must NOT treat them all as missing and mass-insert. Abort the tick instead.
  const inserted: BusyBlockInsert[] = [];
  const deps = {
    loadActiveUpcomingBookings: async () => [booking("E1", "u1"), booking("E2", "u2")],
    loadBusyBlockBookingIds: async () => {
      throw new Error("read blip");
    },
    insertBusyBlocks: async (blocks: BusyBlockInsert[]) => {
      calls.insertBatches++;
      inserted.push(...blocks);
    },
  } as unknown as BookingDeps;
  let threw = false;
  try {
    await reconcileMissingBusyBlocks(deps, 100);
  } catch {
    threw = true;
  }
  assert(threw, "a busy-block read error aborts the sweep (does not swallow)");
  assert(inserted.length === 0, "ZERO inserts on a read error (no mass-insert on a blip)");
}

// --- nothing to do --------------------------------------------------------
{
  const { deps, inserted } = makeDeps({ active: [], haveBlock: [] });
  const res = await reconcileMissingBusyBlocks(deps, 100);
  assert(res.recreated === 0 && inserted.length === 0, "no active bookings -> no-op, no inserts");
}
{
  const { deps, inserted } = makeDeps({
    active: [booking("B1", "u1"), booking("B2", "u2")],
    haveBlock: ["B1", "B2"],
  });
  const res = await reconcileMissingBusyBlocks(deps, 100);
  assert(
    res.recreated === 0 && inserted.length === 0,
    "every active booking already has a block -> no-op (no spurious re-inserts)",
  );
}

// --- the limit is honored -------------------------------------------------
{
  const { deps, calls } = makeDeps({ active: [booking("C1", "u1")], haveBlock: [] });
  await reconcileMissingBusyBlocks(deps, 50);
  assert(calls.loadActiveUpcomingBookings === 50, "passes the scan limit through to the loader");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
