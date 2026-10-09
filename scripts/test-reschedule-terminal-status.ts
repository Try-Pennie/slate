// A reschedule on a booking that can no longer move is an EXPECTED refusal, not an
// unexpected fault (#3569). It must throw the TYPED errors the route maps to a clean
// 4xx, never a plain `Error` that falls through to the generic 500 + Slack page.
//
// On 2026-10-09 `assertReschedulable` threw `new Error("This booking can no longer be
// changed")` and `new Error("Booking not found")`. Neither is an instanceof any typed
// error the reschedule route catches, so both reached `internalErrorResponse`, which
// pages the on-call. A lead clicking a stale reschedule link on a call that already
// happened paged a human (L35: classify errors once).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reschedule-terminal-status.ts
import {
  rescheduleBooking,
  BookingNotChangeableError,
  BookingNotFoundError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, RR, NOW } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const TARGET = "2026-06-09T14:00:00.000Z";
const said = (err: unknown) =>
  err === null ? "no error" : err instanceof Error ? `${err.name}: ${err.message}` : String(err);

async function settle<T>(work: () => Promise<T>): Promise<{ err: unknown }> {
  try {
    await work();
    return { err: null };
  } catch (err) {
    return { err };
  }
}

async function run() {
  // --- cancelled booking: a typed BookingNotChangeableError, never a plain Error ------
  {
    const ctx = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const d: BookingDeps = makeDeps({ existing: ctx }).deps;
    const { err } = await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(
      err instanceof BookingNotChangeableError,
      `a reschedule on a cancelled booking throws BookingNotChangeableError (got ${said(err)})`,
    );
  }

  // --- completed booking: the call already happened, same typed refusal --------------
  {
    const ctx = { booking: makeBooking({ status: "completed" }), bucket, eventType };
    const d: BookingDeps = makeDeps({ existing: ctx }).deps;
    const { err } = await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(
      err instanceof BookingNotChangeableError,
      `a reschedule on a completed booking throws BookingNotChangeableError (got ${said(err)})`,
    );
  }

  // --- token resolves to nothing: a typed BookingNotFoundError, never a plain Error ---
  {
    const d: BookingDeps = makeDeps({ existing: null }).deps;
    const { err } = await settle(() => rescheduleBooking("tok1", TARGET, RR, "customer", d, NOW));
    assert(
      err instanceof BookingNotFoundError,
      `a reschedule on an unknown token throws BookingNotFoundError (got ${said(err)})`,
    );
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
