// Stopping a coverage sweep when the time off that caused it is cancelled (#1665).
//
// Approving time off enqueues a sweep that moves the agent's upcoming customer
// appointments to colleagues (#1237). Cancelling the time off tore down the
// calendar events and the busy block and said nothing to the sweep, so it kept
// moving customers away from an advisor who is now going to be there.
//
// Three item states, and they are the whole of the fix:
//   not yet moved  must not move. The core.
//   already moved  stays moved (#1219 decision 4). Never undone here.
//   mid move       #1235 made the sweep converge after a partial write, so a
//                  cancellation must not strand one halfway.
//
// Every negative below is asserted next to a CONTROL that could have produced the
// opposite in the same fixture (L159): an uncancelled sweep in the same world that
// drains and moves its bookings, so "nothing moved" can never pass because nothing
// COULD have moved.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coverage-sweep-cancel.ts
import { drainBulkReassign } from "../src/lib/booking/bulk-reassign.ts";
import {
  cancelCoverageSweep,
  type CoverageSweepCancelDeps,
} from "../src/lib/booking/coverage-sweep-cancel.ts";
import { BulkReassignWorld } from "./lib/bulk-reassign-world.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const REQ = "req-off";

/** A world holding the cancelled request's sweep AND a control sweep for a
 *  different request, so every "did not move" assertion sits beside a "did move"
 *  from the same drain. */
function twoSweeps(bookings = ["bk1", "bk2", "bk3"], controls = ["ctl1", "ctl2"]) {
  const w = new BulkReassignWorld();
  const target = w.addJob({ id: "job-target", ooo_request_id: REQ });
  const control = w.addJob({ id: "job-control", ooo_request_id: "req-other" });
  for (const b of bookings) w.addPendingItem(target.id, b);
  for (const b of controls) w.addPendingItem(control.id, b);
  return { w, target, control };
}

async function run() {
  // --- the pure decision layer ---------------------------------------------
  {
    const calls: string[] = [];
    const deps: CoverageSweepCancelDeps = {
      findJobs: async () => [
        { id: "j1", status: "active" },
        { id: "j2", status: "done" },
      ],
      cancelJob: async (id) => {
        calls.push(`cancelJob:${id}`);
      },
      cancelPendingItems: async (id) => {
        calls.push(`cancelItems:${id}`);
        return id === "j1" ? 2 : 0;
      },
      countMovedItems: async (id) => {
        calls.push(`countMoved:${id}`);
        return id === "j1" ? 1 : 3;
      },
    };
    const report = await cancelCoverageSweep(deps);
    eq(report.stopped, 2, "the report counts the appointments this cancellation actually stopped");
    eq(report.alreadyMoved, 4, "the report counts what had already moved, across every sweep for the request");
    eq(report.jobs, 2, "every sweep the request produced is settled, not just the newest");
    assert(
      calls.indexOf("cancelJob:j1") < calls.indexOf("cancelItems:j1"),
      "the JOB is cancelled before its items, so a crash in between leaves the drain able to converge the rest",
    );

    const none = await cancelCoverageSweep({ ...deps, findJobs: async () => [] });
    eq(none.jobs, 0, "a request that never had a sweep reports nothing rather than inventing a zero");
    eq(none.stopped + none.alreadyMoved, 0, "and nothing was stopped or moved");
  }

  // --- 1. cancel before the sweep has started moves nothing -----------------
  {
    const { w, target, control } = twoSweeps();
    const report = await cancelCoverageSweep(w.cancelDeps(REQ));
    const summary = await drainBulkReassign(w.drainDeps());

    eq(report.stopped, 3, "all three appointments were still waiting, so all three are stopped");
    eq(report.alreadyMoved, 0, "none had moved yet");
    for (const b of ["bk1", "bk2", "bk3"]) {
      eq(w.assigneeOf(b), "agent-out", `${b} stays with the advisor who is now going to be there`);
      eq(w.statusOf(b), "cancelled", `${b} is recorded as stopped, not as skipped or moved`);
      eq(w.reassignCountFor(b), 0, `${b} was never handed to another advisor`);
    }
    // The control: the same drain, the same world, a sweep nobody cancelled.
    eq(w.assigneeOf("ctl1"), "agent-cover", "CONTROL: an uncancelled sweep in the same drain still moves its bookings");
    eq(w.assigneeOf("ctl2"), "agent-cover", "CONTROL: and every one of them, so the fixture could have moved the others");
    eq(summary.moved, 2, "the drain moved exactly the control's two, and nothing from the cancelled sweep");
    eq(w.jobStatus(target.id), "cancelled", "the stopped sweep is terminal");
    eq(w.jobStatus(control.id), "done", "the control sweep drained to done");
    eq(w.strandedJobs().length, 0, "no sweep is left active with nothing pending for any lane to pick up");
    eq(w.strandedItems().length, 0, "no appointment is left pending under a sweep nothing drains");
  }

  // --- 2. cancel mid drain: the rest stop, the moved one stays moved --------
  {
    const { w, target } = twoSweeps();
    // One tick, one item: bk1 moves.
    await drainBulkReassign(w.drainDeps(), 1);
    eq(w.assigneeOf("bk1"), "agent-cover", "the first appointment moved before anyone cancelled");

    const report = await cancelCoverageSweep(w.cancelDeps(REQ));
    await drainBulkReassign(w.drainDeps());

    eq(report.alreadyMoved, 1, "the manager is told the one that had already moved");
    eq(report.stopped, 2, "and that the other two were stopped");
    eq(w.statusOf("bk1"), "moved", "the moved appointment is still recorded as moved");
    eq(w.assigneeOf("bk1"), "agent-cover", "and stays with the covering advisor (#1219 decision 4)");
    eq(w.reassignCountFor("bk1"), 1, "it is not moved a second time by the later drain");
    for (const b of ["bk2", "bk3"]) {
      eq(w.statusOf(b), "cancelled", `${b} was still waiting, so it is stopped`);
      eq(w.assigneeOf(b), "agent-out", `${b} stays with the advisor who is coming back`);
    }
    eq(w.jobStatus(target.id), "cancelled", "the sweep itself is stopped, not left active");
    eq(w.strandedJobs().length, 0, "nothing is left active with no pending work");

    // CONTROL: the same two ticks with no cancellation move all three.
    const c = twoSweeps();
    await drainBulkReassign(c.w.drainDeps(), 1);
    await drainBulkReassign(c.w.drainDeps());
    eq(c.w.assigneeOf("bk2"), "agent-cover", "CONTROL: with no cancellation the second tick moves bk2");
    eq(c.w.assigneeOf("bk3"), "agent-cover", "CONTROL: and bk3, so the stop above is what held them");
    eq(c.w.jobStatus(c.target.id), "done", "CONTROL: an uncancelled sweep ends done");
  }

  // --- 3a. the race: the cancel lands while one item is being moved ---------
  //
  // The database write and the calendar write for bk1 have happened; the item's
  // outcome has not been recorded yet. That is the mid-move state #1235 is about.
  // It must finish and be recorded as moved: the booking really is with somebody
  // else now, and an item reading 'cancelled' over it would be a lie that a later
  // re-approval would act on.
  {
    const { w, target } = twoSweeps();
    let cancelled = false;
    w.onBeforeReassign = async (bookingId) => {
      if (bookingId !== "bk1" || cancelled) return;
      cancelled = true;
      await cancelCoverageSweep(w.cancelDeps(REQ));
    };
    const summary = await drainBulkReassign(w.drainDeps());

    assert(cancelled, "the cancellation really did land inside the drain (the race was exercised)");
    eq(w.statusOf("bk1"), "moved", "the appointment that was mid move is recorded as moved, not stranded");
    eq(w.assigneeOf("bk1"), "agent-cover", "and the customer is with the advisor who took it");
    eq(w.reassignCountFor("bk1"), 1, "it was handed over exactly once");
    for (const b of ["bk2", "bk3"]) {
      eq(w.statusOf(b), "cancelled", `${b} was not yet touched, so the cancellation stopped it`);
      eq(w.reassignCountFor(b), 0, `${b} was never moved`);
    }
    eq(
      summary.unclaimed,
      2,
      "the drain reports the two it refused rather than counting them as moved",
    );
    eq(w.refusedClaims.length, 2, "and it refused them by asking the store, not from its own stale batch");
    eq(w.jobStatus(target.id), "cancelled", "the sweep is terminal");
    eq(w.strandedJobs().length, 0, "the race leaves no sweep for a lane to never pick up");
    eq(w.strandedItems().length, 0, "and no item pending under a stopped sweep");

    // Nothing is left for a later tick to redo.
    const after = await drainBulkReassign(w.drainDeps());
    eq(after.processed, 0, "a later tick finds nothing, so nothing can be moved twice");
    eq(w.reassignCountFor("bk1"), 1, "and bk1 is still moved exactly once");
  }

  // --- 3b. the race with a FAILED move: the retry must not resurrect it -----
  //
  // The nastier half. The drain took bk1, the cancel landed, and then the move
  // failed, so the engine's own answer is "pending, try again". Writing that back
  // would put a cancelled appointment into a queue that no longer has a reason to
  // exist, and the next tick would move the customer after all.
  {
    const { w } = twoSweeps();
    w.failReassignFor.add("bk1");
    let cancelled = false;
    w.onBeforeReassign = async (bookingId) => {
      if (bookingId !== "bk1" || cancelled) return;
      cancelled = true;
      await cancelCoverageSweep(w.cancelDeps(REQ));
    };
    await drainBulkReassign(w.drainDeps());

    assert(cancelled, "the cancellation landed inside the failing move");
    eq(w.statusOf("bk1"), "cancelled", "a move that failed after the cancellation stays stopped");
    eq(w.assigneeOf("bk1"), "agent-out", "and the customer stays with their own advisor");
    assert(
      w.refusedCommits.some((r) => r.status === "cancelled"),
      "the store REFUSED the retry write rather than the engine remembering not to make it",
    );
    const after = await drainBulkReassign(w.drainDeps());
    eq(after.processed, 0, "and no later tick picks it up");
    eq(w.reassignCountFor("bk1"), 0, "so the customer is never moved");

    // CONTROL: the identical failure with no cancellation DOES stay pending and is
    // retried, so the assertion above is about the cancellation, not about failure.
    const c = twoSweeps();
    c.w.failReassignFor.add("bk1");
    await drainBulkReassign(c.w.drainDeps());
    eq(c.w.statusOf("bk1"), "pending", "CONTROL: a failed move with no cancellation is left to retry");
  }

  // --- 3c. a cancel that died between its two writes still converges --------
  //
  // The job was flipped to 'cancelled' and the process died before the items were.
  // The drain is the second guard: it refuses an item whose sweep is stopped and
  // records it, so the leftovers settle themselves instead of being moved.
  {
    const { w, target } = twoSweeps();
    await w.cancelDeps(REQ).cancelJob(target.id); // half a cancellation, deliberately
    eq(w.pendingCount(target.id), 3, "the items really were left pending by the half cancellation");

    const summary = await drainBulkReassign(w.drainDeps());
    for (const b of ["bk1", "bk2", "bk3"]) {
      eq(w.assigneeOf(b), "agent-out", `${b} is not moved by a sweep that is already stopped`);
      eq(w.statusOf(b), "cancelled", `${b} settles itself rather than staying pending forever`);
    }
    eq(summary.moved, 2, "CONTROL: the uncancelled sweep in the same tick still moved its two");
    eq(w.strandedItems().length, 0, "the half cancellation converges instead of stranding");
  }

  // --- running it twice ------------------------------------------------------
  {
    const { w, target } = twoSweeps();
    const first = await cancelCoverageSweep(w.cancelDeps(REQ));
    const second = await cancelCoverageSweep(w.cancelDeps(REQ));
    eq(first.stopped, 3, "the first cancellation stops three");
    eq(second.stopped, 0, "the second stops nothing, because there is nothing left in a stoppable state");
    eq(second.alreadyMoved, 0, "and it does not double count what moved");
    eq(w.jobStatus(target.id), "cancelled", "the sweep is still exactly once cancelled");
    await drainBulkReassign(w.drainDeps());
    for (const b of ["bk1", "bk2", "bk3"]) eq(w.reassignCountFor(b), 0, `${b} is still never moved`);
  }

  // --- a sweep that had already finished ------------------------------------
  {
    const { w, target } = twoSweeps();
    await drainBulkReassign(w.drainDeps());
    eq(w.jobStatus(target.id), "done", "the sweep drained before anybody cancelled");
    const report = await cancelCoverageSweep(w.cancelDeps(REQ));
    eq(report.stopped, 0, "there is nothing left to stop");
    eq(report.alreadyMoved, 3, "and all three are reported as having already moved");
    eq(w.jobStatus(target.id), "done", "a finished sweep stays finished rather than being relabelled cancelled");
    for (const b of ["bk1", "bk2", "bk3"]) {
      eq(w.assigneeOf(b), "agent-cover", `${b} stays with the covering advisor`);
    }
  }
}

await run();
finish();
