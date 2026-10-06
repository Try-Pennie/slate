// A reschedule that has committed is answered as one, and its outbox work is never lost
// (#3265, the reschedule half of #3263).
//
// Two defects, both after `commitReschedule`. The outbox work work (the slot move, the
// recompute, the rescheduled webhook to Regal) was queued by a SEPARATE outbox insert
// after the commit, so a failed insert left a committed move with no durable record of
// its side effects. And everything after the commit ran under the confirm budget, so a
// deadline there answered the lead a retryable error for a move that had already
// happened.
//
// The fix this pins: the commit is handed the outbox work and writes it in the SAME
// transaction (migration 0171), and nothing after a committed move turns into an error
// for the lead. The budget is the real `call-budget.ts` one, spent the moment the
// commit lands, so the refusals after it are the ones the real clients make.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reschedule-committed.ts
import { rescheduleBooking, RescheduleConflictError, type BookingDeps } from "../src/lib/booking/orchestration.ts";
import { deadlineWithinBudget, withinCallBudget } from "../src/lib/call-budget.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, RR, NOW } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();
const TARGET = "2026-06-09T14:00:00.000Z";

/** A confirm budget on a clock this test moves past its end. */
function confirmClock() {
  let skew = 0;
  const now = () => Date.now() + skew;
  return {
    spend: () => {
      skew = 13_000;
    },
    run: <T>(work: () => Promise<T>) => withinCallBudget(12_000, "the booking confirm", work, now),
    call: (label: string) => {
      deadlineWithinBudget(4_000, label, now);
    },
  };
}

async function settle<T>(work: () => Promise<T>): Promise<{ value: T | null; err: unknown }> {
  try {
    return { value: await work(), err: null };
  } catch (err) {
    return { value: null, err };
  }
}
const said = (err: unknown) => (err === null ? "no error" : err instanceof Error ? `${err.name}: ${err.message}` : String(err));

async function run() {
  // --- committed, then out of time: answered, with its outbox work already queued ------
  {
    const clock = confirmClock();
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const fx = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    const d: BookingDeps = {
      ...fx.deps,
      commitReschedule: async (...args) => {
        const r = await fx.deps.commitReschedule(...args);
        clock.spend();
        return r;
      },
      // Every call after the commit asks the budget, as the real clients do.
      deleteEvent: async (...args) => {
        clock.call("google events.delete");
        return fx.deps.deleteEvent(...args);
      },
      leaseOutbox: async (...args) => {
        clock.call("supabase");
        return fx.deps.leaseOutbox(...args);
      },
      saveOutboxSteps: async (...args) => {
        clock.call("supabase");
        return fx.deps.saveOutboxSteps(...args);
      },
    };
    const { value, err } = await settle(() => clock.run(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW)));
    assert(err === null, `a reschedule that committed is answered, not refused, when the budget runs out after it (got ${said(err)})`);
    assert(value !== null && Date.parse(value.booking.starts_at) === Date.parse(TARGET), "and it is answered at its new time");
    const handed = fx.calls.commitReschedule[0]?.outbox as { steps?: unknown; payload?: { reasonCode?: unknown } } | undefined;
    assert(Array.isArray(handed?.steps) && handed.steps.length > 0, `the commit was handed the outbox steps, so they are written in its transaction (got ${JSON.stringify(handed ?? null)})`);
    assert(handed?.payload?.reasonCode === RR.code, "with the payload the rescheduled webhook needs");
    assert(fx.calls.rescheduleOutbox.length === 1, "the outbox work was recorded with the move");
    assert(fx.calls.enqueuedOutbox.length === 0, `and not by a separate insert afterwards (got ${JSON.stringify(fx.calls.enqueuedOutbox)})`);
  }

  // --- a failure after the commit is the drain's to finish, never the lead's error ----
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const fx = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    const d: BookingDeps = {
      ...fx.deps,
      leaseOutbox: async () => {
        throw new Error("supabase 503 on the lease");
      },
    };
    const { value, err } = await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(err === null && value !== null, `a failed inline outbox step after the commit is not the lead's error (got ${said(err)})`);
    assert(fx.calls.rescheduleOutbox.length === 1, "the outbox work the drain will run was already recorded with the move");
  }

  // --- the guard still refuses a move whose booking changed, and records nothing -------
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const fx = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    const d: BookingDeps = {
      ...fx.deps,
      // A concurrent cancel changed the row after it was read: the commit touches nothing.
      commitReschedule: async (...args) => {
        fx.calls.commitReschedule.push({ id: args[0], patch: args[1] as Record<string, unknown>, guard: args[2], outbox: args[3] });
        return null;
      },
      loadBookingById: async () => ({ booking: makeBooking({ status: "cancelled" }), bucket, eventType }),
    };
    const { err } = await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(err instanceof RescheduleConflictError, `a move whose booking changed underneath it is refused as a conflict (got ${said(err)})`);
    assert(fx.calls.rescheduleOutbox.length === 0 && fx.calls.enqueuedOutbox.length === 0, "and no outbox work is recorded for a move that never happened");
  }

  // --- a retry after a commit: reuse the outbox work the commit recorded ------------------
  // The first attempt's commit lands and its process dies before answering. The retry
  // finds the booking already at its target with this ordinal, and must not queue the
  // same outbox work a second time.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const fx = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    let died = false;
    const commit = fx.deps.commitReschedule.bind(fx.deps);
    fx.deps.commitReschedule = async (...args) => {
      const r = await commit(...args);
      if (!died) {
        died = true;
        throw new Error("injected crash after the commit landed");
      }
      return r;
    };
    const release = fx.deps.releaseReschedule.bind(fx.deps);
    let suppressed = false;
    fx.deps.releaseReschedule = async (id) => {
      if (!suppressed) {
        suppressed = true;
        return;
      }
      return release(id);
    };
    await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", fx.deps, NOW));
    fx.expireLease("bk1");
    const { err } = await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", fx.deps, NOW));
    assert(err === null, `the retry is answered (got ${said(err)})`);
    assert(fx.calls.rescheduleOutbox.length === 1, `the outbox work exists once, from the commit that landed (got ${fx.calls.rescheduleOutbox.length})`);
    assert(fx.calls.enqueuedOutbox.length === 0, `and the retry does not queue it again (got ${JSON.stringify(fx.calls.enqueuedOutbox)})`);
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
