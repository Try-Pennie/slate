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
import { assert, finish } from "./lib/harness.ts";

function booking(id: string, user_id: string): ActiveUpcomingBooking {
  return {
    id,
    user_id,
    starts_at: `2030-01-01T10:00:00.000Z`,
    ends_at: `2030-01-01T10:30:00.000Z`,
  };
}

/** One row the fake database inserted, as the RPC answers it. */
type Recreated = { booking_id: string; user_id: string };

function makeDeps(opts: {
  active: ActiveUpcomingBooking[];
  haveBlock: string[];
  /** Ids cancelled after the sweep's reads (#3585, #3592). The database's own active
   *  check inside the one statement sees them, so it inserts nothing for them. */
  cancelledBeforeInsert?: string[];
}) {
  const inserted: Recreated[] = [];
  const blocks = new Set(opts.haveBlock);
  const calls = {
    loadActiveUpcomingBookings: 0,
    loadBusyBlockBookingIds: [] as string[][],
    recreateMissingBusyBlocks: [] as string[][],
  };
  const cancelled = new Set(opts.cancelledBeforeInsert ?? []);
  const agentOf = new Map(opts.active.map((b) => [b.id, b.user_id]));
  const deps = {
    loadActiveUpcomingBookings: async (limit: number) => {
      calls.loadActiveUpcomingBookings = limit;
      return opts.active;
    },
    loadBusyBlockBookingIds: async (ids: string[]) => {
      calls.loadBusyBlockBookingIds.push(ids);
      return new Set(opts.haveBlock.filter((id) => ids.includes(id)));
    },
    // The conditional insert, modelled: still active, and no block yet (ON CONFLICT DO
    // NOTHING). Answers with the rows it inserted, as the RPC's RETURNING does.
    recreateMissingBusyBlocks: async (ids: string[]) => {
      calls.recreateMissingBusyBlocks.push(ids);
      const rows: Recreated[] = [];
      for (const id of ids) {
        if (cancelled.has(id) || blocks.has(id)) continue;
        blocks.add(id);
        rows.push({ booking_id: id, user_id: agentOf.get(id) as string });
      }
      inserted.push(...rows);
      return rows;
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
    calls.recreateMissingBusyBlocks.length === 1,
    "#762: the missing blocks go out in ONE batched write, not one write per row",
  );
  // #3592: the block's agent and window come from the booking row inside the
  // statement (proved in pnpm verify:recreate-missing-busy-blocks-sql); the sweep
  // hands over only the candidate ids.
  assert(
    calls.recreateMissingBusyBlocks[0]!.slice().sort().join(",") === "A1,A2",
    "#3592: asks the database to re-create exactly the missing candidates",
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
  const inserted: string[] = [];
  let insertCalls = 0;
  const deps = {
    loadActiveUpcomingBookings: async () => [booking("E1", "u1"), booking("E2", "u2")],
    loadBusyBlockBookingIds: async () => {
      throw new Error("read blip");
    },
    recreateMissingBusyBlocks: async (ids: string[]) => {
      insertCalls++;
      inserted.push(...ids);
      return [];
    },
  } as unknown as BookingDeps;
  // The message is asserted, not merely that SOMETHING threw. `assert(threw)` alone
  // is satisfied by any error, including one raised by this fake: the insert branch
  // used to increment an undefined `calls`, which threw BEFORE recording anything, so
  // threw became true, `inserted` stayed empty, and BOTH assertions below passed. Had
  // the sweep ever regressed into mass-inserting, this test would have reported
  // success on exactly the branch that exists to stop bulk writes.
  let caught: unknown = null;
  try {
    await reconcileMissingBusyBlocks(deps, 100);
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, "a busy-block read error aborts the sweep (does not swallow)");
  assert(
    caught instanceof Error && /read blip/.test(caught.message),
    `it aborts on the READ error, not on some other failure (got: ${caught instanceof Error ? caught.message : String(caught)})`,
  );
  assert(insertCalls === 0, "the insert was never even attempted on a read error");
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

// --- #3585 / #3592: a cancel landing after the reads is not re-created ---------------
{
  // D1 looked active and its block is gone (the cancel deleted it); by the time the
  // insert runs it is cancelled, which the statement's own check sees. D2 beside it is
  // a genuine missed write for a still-active booking and IS re-created. The counts
  // come from the rows the statement inserted, so D1 is neither counted nor named.
  const { deps, inserted, calls } = makeDeps({
    active: [booking("D1", "u1"), booking("D2", "u2")],
    haveBlock: [],
    cancelledBeforeInsert: ["D1"],
  });
  const res = await reconcileMissingBusyBlocks(deps, 100);
  assert(res.recreated === 1, "only the still-active missing block is re-created");
  assert(res.bookingIds.length === 1 && res.bookingIds[0] === "D2", "and it is D2, not the cancelled D1");
  assert(JSON.stringify(res.userIds) === JSON.stringify(["u2"]), "#3592: and only D2's agent is recomputed");
  assert(!inserted.some((b) => b.booking_id === "D1"), "no block is re-created for the booking being cancelled");
  assert(
    calls.recreateMissingBusyBlocks.length === 1 &&
      calls.recreateMissingBusyBlocks[0]!.slice().sort().join(",") === "D1,D2",
    "the conditional insert is asked about only the missing candidates",
  );
}

// --- #3592: an insert that wrote no row reports nothing ---------------------------------
{
  // The booking's own write through (or a move) landed between the block read and the
  // insert, so ON CONFLICT DO NOTHING inserted nothing. Modelled by the cancel set, which
  // the fake treats the same way: no row comes back.
  const { deps } = makeDeps({ active: [booking("F1", "u1")], haveBlock: [], cancelledBeforeInsert: ["F1"] });
  const res = await reconcileMissingBusyBlocks(deps, 100);
  assert(
    res.recreated === 0 && res.bookingIds.length === 0 && res.userIds.length === 0,
    "#3592: an insert that wrote no row reports nothing re-created",
  );
  assert(res.scanned === 1, "#3592: while still reporting the scan size for the cursor");
}

// --- #3592: a failed insert aborts with no count ----------------------------------------
{
  const deps = {
    loadActiveUpcomingBookings: async () => [booking("G1", "u1")],
    loadBusyBlockBookingIds: async () => new Set<string>(),
    recreateMissingBusyBlocks: async () => {
      throw new Error("rpc refused");
    },
  } as unknown as BookingDeps;
  let caught: unknown = null;
  try {
    await reconcileMissingBusyBlocks(deps, 100);
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof Error && /rpc refused/.test(caught.message),
    "#3592: a refused insert throws rather than reporting the candidates as re-created",
  );
}

// --- no insert call when nothing is missing --------------------------------------------
{
  const { deps, calls } = makeDeps({ active: [booking("E1", "u1")], haveBlock: ["E1"] });
  const res = await reconcileMissingBusyBlocks(deps, 100);
  assert(res.recreated === 0, "nothing missing, nothing re-created");
  assert(calls.recreateMissingBusyBlocks.length === 0, "and no insert is issued when nothing is missing");
}

finish();
