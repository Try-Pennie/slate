// Demo bookings cancel themselves 30 minutes after they are made (#3424).
//
// The sweep's decisions, driven through hand written deps with an injected clock:
// what counts as due, that every due booking is attempted even after one fails,
// that a failure is LOUD (it throws, so the complete lane's failing streak can
// page), and that a full batch reports a backlog rather than a clean sweep.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-demo-auto-cancel.ts
import {
  DEMO_AUTO_CANCEL_AFTER_MS,
  DEMO_AUTO_CANCEL_BATCH,
  DEMO_AUTO_CANCEL_REASON,
  DemoAutoCancelError,
  cancelDueDemoBookings,
  type DemoAutoCancelDeps,
} from "../src/lib/booking/demo-auto-cancel.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 6, 18, 0, 0);

function deps(
  due: { id: string; manageToken: string }[],
  cancel: (token: string) => Promise<boolean> = async () => true,
) {
  const asked: { cutoffIso: string; limit: number }[] = [];
  const cancelled: string[] = [];
  const reported: { id: string; err: unknown }[] = [];
  const d: DemoAutoCancelDeps = {
    reportFailure: (id, err) => {
      reported.push({ id, err });
    },
    listDue: async (cutoffIso, limit) => {
      asked.push({ cutoffIso, limit });
      return due.slice(0, limit);
    },
    cancel: async (token) => {
      cancelled.push(token);
      return cancel(token);
    },
  };
  return { d, asked, cancelled, reported };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, manageToken: `t${i}` }));

await (async () => {
  // --- the rule itself ---------------------------------------------------------------
  eq(DEMO_AUTO_CANCEL_AFTER_MS, 30 * 60_000, "a demo booking lives 30 minutes (Dan, 2026-10-06)");
  eq(DEMO_AUTO_CANCEL_REASON.code, "demo_auto_cancel", "the cancel records its own reason, never a lead's");

  // --- nothing due -----------------------------------------------------------------
  {
    const { d, asked, cancelled } = deps([]);
    const r = await cancelDueDemoBookings(d, NOW);
    eq(r, { cancelled: 0, alreadyGone: 0, backlogRemains: false }, "an empty sweep reports nothing done");
    eq(asked.length, 1, "it asks once");
    eq(asked[0]!.cutoffIso, new Date(NOW - DEMO_AUTO_CANCEL_AFTER_MS).toISOString(), "due means made 30 minutes or more ago");
    eq(asked[0]!.limit, DEMO_AUTO_CANCEL_BATCH, "the read is bounded by the batch");
    eq(cancelled.length, 0, "and cancels nothing");
  }

  // --- some due ----------------------------------------------------------------------
  {
    const { d, cancelled } = deps(rows(3));
    const r = await cancelDueDemoBookings(d, NOW);
    eq(cancelled, ["t0", "t1", "t2"], "every due booking is cancelled, by its manage token");
    eq(r, { cancelled: 3, alreadyGone: 0, backlogRemains: false }, "and counted");
  }

  // --- lost a race -------------------------------------------------------------------
  {
    // A visitor who cancels on the manage page at minute 29 races the sweep: the
    // claim goes to them, the sweep's cancel answers false, and that is not a fault.
    const { d } = deps(rows(2), async (t) => t !== "t1");
    const r = await cancelDueDemoBookings(d, NOW);
    eq(r, { cancelled: 1, alreadyGone: 1, backlogRemains: false }, "a booking somebody else cancelled first is counted apart");
  }

  // --- a full batch ------------------------------------------------------------------
  {
    const { d } = deps(rows(DEMO_AUTO_CANCEL_BATCH + 4));
    const r = await cancelDueDemoBookings(d, NOW);
    eq(r.cancelled, DEMO_AUTO_CANCEL_BATCH, "one batch per run");
    eq(r.backlogRemains, true, "and a full batch says more may be waiting, rather than reading as done");
  }

  // --- a failure is loud, and does not stop the rest ---------------------------------
  {
    const { d, cancelled, reported } = deps(rows(3), async (t) => {
      if (t === "t1") throw new Error("google said no");
      return true;
    });
    let caught: unknown = null;
    try {
      await cancelDueDemoBookings(d, NOW);
    } catch (err) {
      caught = err;
    }
    eq(cancelled, ["t0", "t1", "t2"], "the bookings after a failed one are still attempted");
    assert(caught instanceof DemoAutoCancelError, "a failed cancel makes the sweep throw its own error");
    const e = caught as DemoAutoCancelError;
    eq(e.failedIds, ["b1"], "naming the booking that failed, by id and never by token");
    eq(e.cancelled, 2, "and how many did go through");
    assert(!e.message.includes("t1"), "the message never carries a manage token, which can cancel the booking");
    // The CAUSE reaches the log with the booking it belongs to, so a failing sweep
    // says whether Google, the database or something else refused it.
    eq(reported.length, 1, "each failed cancel is reported once");
    eq(reported[0]!.id, "b1", "with the booking's id");
    assert(reported[0]!.err instanceof Error && (reported[0]!.err as Error).message === "google said no", "and the error itself, not a summary of it");
  }

  // --- a read that fails is loud too --------------------------------------------------
  {
    const d: DemoAutoCancelDeps = {
      reportFailure: () => {},
      listDue: async () => {
        throw new Error("read refused");
      },
      cancel: async () => true,
    };
    let threw = false;
    try {
      await cancelDueDemoBookings(d, NOW);
    } catch {
      threw = true;
    }
    assert(threw, "a read that fails throws rather than reading as nothing due");
  }
})();

finish();
