// Test for the convergent coverage-sweep enqueue (#1235): the decision layer that
// makes "enqueue a sweep for this time-off request and window" safe to run twice.
//
// Creating a sweep is TWO writes, the job row then its items, so a crash or an
// error between them leaves a job with status 'active' and zero items. Nothing
// drains it: the engine only flips a job to 'done' for a job a tick actually
// touched, so it sits active forever having moved nothing. A unique key on
// (request, window) that merely REFUSED the second attempt would turn that
// recoverable half-write into a permanent silent failure, and would report success
// while doing it. So the conflict path re-snapshots into the existing job instead
// of returning it untouched.
//
// The same path covers a routine case: modifying an approved request clears its
// side effects and returns it to pending, and validateWindow does not require the
// window to have changed, so a re-approval can legitimately need the SAME window
// swept again. During the pending gap the agent is bookable and new bookings land;
// re-snapshotting picks them up, refusing would strand them.
//
// Pure-with-fakes → node harness (no module mocking).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coverage-sweep-enqueue.ts
import { enqueueCoverageSweep, type CoverageSweepEnqueueDeps } from "../src/lib/booking/coverage-sweep-enqueue.ts";
import { assert, finish } from "./lib/harness.ts";

/** Records every call so each assertion can name what the decision actually did. */
function fakes(over: Partial<CoverageSweepEnqueueDeps> = {}) {
  const calls = {
    insertJob: [] as { status: "active" | "done" }[],
    findExisting: 0,
    addItems: [] as { jobId: string; bookingIds: string[] }[],
    reactivate: [] as string[],
  };
  const deps: CoverageSweepEnqueueDeps = {
    snapshotBookingIds: async () => ["bk1", "bk2"],
    insertJob: async (status) => {
      calls.insertJob.push({ status });
      return { ok: true, jobId: "job-new" };
    },
    findExistingJob: async () => {
      calls.findExisting++;
      return { id: "job-existing" };
    },
    addItems: async (jobId, bookingIds) => {
      calls.addItems.push({ jobId, bookingIds });
      return bookingIds.length;
    },
    reactivateJob: async (jobId) => {
      calls.reactivate.push(jobId);
    },
    ...over,
  };
  return { deps, calls };
}

async function run() {
  // --- the ordinary path ----------------------------------------------------
  let f = fakes();
  let r = await enqueueCoverageSweep(f.deps);
  assert(r.jobId === "job-new" && r.itemCount === 2, "a fresh sweep returns its new job id and item count");
  assert(f.calls.insertJob[0].status === "active", "a sweep with work to do is born active");
  assert(f.calls.addItems[0].bookingIds.length === 2, "every snapshotted booking becomes an item");
  assert(f.calls.findExisting === 0, "no conflict means no lookup of an existing sweep");
  assert(f.calls.reactivate.length === 0, "a fresh sweep is never reactivated");

  // A window with nothing in it is a legitimate, common outcome: time off approved
  // further ahead than the booking horizon has no bookings to move. It must be
  // born done, not left active with nothing to drain.
  f = fakes({ snapshotBookingIds: async () => [] });
  r = await enqueueCoverageSweep(f.deps);
  assert(r.itemCount === 0, "a window with no bookings reports zero items");
  assert(f.calls.insertJob[0].status === "done", "a sweep with no work is born done, never active-and-empty");
  assert(f.calls.addItems.length === 0, "no items are written when there is nothing to move");

  // --- the half-write, which is the whole reason this layer exists ----------
  //
  // A prior attempt inserted the job and then failed to insert its items. The
  // retry hits the unique key. Returning the existing job id here would report
  // success for a sweep holding zero items that nothing will ever drain.
  f = fakes({ insertJob: async () => ({ ok: false, conflict: true, message: "duplicate key" }) });
  r = await enqueueCoverageSweep(f.deps);
  assert(r.jobId === "job-existing", "a conflict resolves to the sweep that already exists");
  assert(
    f.calls.addItems[0]?.jobId === "job-existing" && f.calls.addItems[0].bookingIds.length === 2,
    "a conflict RE-SNAPSHOTS the bookings into the existing sweep instead of returning it untouched",
  );
  assert(
    f.calls.reactivate[0] === "job-existing",
    "a sweep that gained work is put back to active so the drain picks it up",
  );

  // Nothing new to add: a genuine duplicate call, or every booking already an item.
  // Reactivating here would leave a job active with no pending items, which is the
  // very state this exists to prevent (nothing ever flips it back to done).
  f = fakes({
    insertJob: async () => ({ ok: false, conflict: true, message: "duplicate key" }),
    addItems: async () => 0,
  });
  r = await enqueueCoverageSweep(f.deps);
  assert(r.jobId === "job-existing", "a duplicate enqueue still resolves to the existing sweep");
  assert(
    f.calls.reactivate.length === 0,
    "a sweep that gained NO new work is left alone, never flipped active-and-empty",
  );

  // A conflict with no bookings in range: nothing to add, nothing to reactivate.
  f = fakes({
    insertJob: async () => ({ ok: false, conflict: true, message: "duplicate key" }),
    snapshotBookingIds: async () => [],
  });
  r = await enqueueCoverageSweep(f.deps);
  assert(
    r.jobId === "job-existing" && r.itemCount === 0 && f.calls.addItems.length === 0,
    "a conflict with an empty window touches nothing and reports zero",
  );

  // --- the failure paths ----------------------------------------------------
  //
  // A conflict says a row exists, so failing to find it means the two disagree.
  // Reporting success off that would be the amnesiac failure this layer removes.
  f = fakes({
    insertJob: async () => ({ ok: false, conflict: true, message: "duplicate key" }),
    findExistingJob: async () => null,
  });
  let threw = "";
  try {
    await enqueueCoverageSweep(f.deps);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw !== "", "a conflict whose existing sweep cannot be found FAILS LOUD rather than reporting success");
  assert(f.calls.addItems.length === 0, "nothing is written when the existing sweep cannot be identified");

  // Any other insert error is a real error and must not be mistaken for a
  // duplicate: swallowing it would silently drop the sweep entirely.
  f = fakes({
    insertJob: async () => ({ ok: false, conflict: false, message: "null value in column org_id" }),
  });
  threw = "";
  try {
    await enqueueCoverageSweep(f.deps);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw.includes("org_id"), "a non-conflict insert error throws with its cause");

  // An items write that fails must throw, so the caller records a failure and a
  // retry can converge. Silently returning would leave the active-and-empty job.
  f = fakes({
    addItems: async () => {
      throw new Error("items insert failed");
    },
  });
  threw = "";
  try {
    await enqueueCoverageSweep(f.deps);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw.includes("items insert failed"), "a failed items write throws so the enqueue can be retried");
}

await run();
finish();
