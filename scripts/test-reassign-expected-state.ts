// #1677: a coverage move commits only if the booking is still where the sweep saw it.
//
// The drain reads a booking, spends seconds choosing a covering advisor for its time,
// then reassigns it. An admin's own reassign, a second sweep, or the lead's reschedule
// landing in between used to be overwritten by the swap. `reassignBooking` now takes the
// state the caller verified (`expect`): it refuses before creating any calendar event when
// the booking it loads already differs, and the swap refuses under its row lock
// (migration 0196) when the change lands after that, the created event then rolled back.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reassign-expected-state.ts
import { reassignBooking } from "../src/lib/booking/orchestration.ts";
import { RerouteRefusedError } from "../src/lib/booking/reroute.ts";
import type { User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, SYS } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const START = "2026-06-08T13:00:00.000Z";
const cover = { id: "b", name: "Cover B", email: "b@x.com", bookable: true } as unknown as User;
const expectOut = { assignedUserId: "a", startsAt: START };

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

async function run() {
  // The booking is where the sweep saw it: the move goes ahead, and the swap is handed
  // the expectation so the database can hold it to it.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: cover });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps, { expect: expectOut });
    assert(res.booking.assigned_user_id === "b", "an unchanged booking is moved");
    assert(
      JSON.stringify(calls.reassignSwapExpects) === JSON.stringify([expectOut]),
      "and the swap is handed the state the caller verified",
    );
  }

  // Already moved by somebody else when the reassign loads it: refused before any
  // calendar event is created, so nothing is written anywhere.
  {
    const ctx = { booking: makeBooking({ assigned_user_id: "c" }), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: cover });
    const err = await refusal(reassignBooking("bk1", "b@x.com", SYS, deps, { expect: expectOut }));
    assert(err instanceof RerouteRefusedError && err.code === "booking_moved", "a booking already moved off the out agent is refused as moved");
    assert(calls.createEvent.length === 0 && calls.reassignSwaps.length === 0, "with no calendar event created and no swap");
    assert(ctx.booking.assigned_user_id === "c", "and the advisor somebody else chose is kept");
  }

  // Rescheduled by the lead to a time the covering advisor was never checked for.
  {
    const ctx = { booking: makeBooking({ starts_at: "2026-06-08T15:00:00.000Z" }), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: cover });
    const err = await refusal(reassignBooking("bk1", "b@x.com", SYS, deps, { expect: expectOut }));
    assert(err instanceof RerouteRefusedError && err.code === "booking_moved", "a booking at a new time is refused as moved");
    assert(calls.createEvent.length === 0, "before any calendar event");
  }

  // The interleaving that matters: the change lands AFTER the reassign loaded the booking
  // and created the new event, and before the swap. The swap refuses under its lock, the
  // event it created is rolled back, and the other writer's advisor stands.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      bookingById: ctx,
      agentByEmail: cover,
      beforeReassignSwap: (b) => {
        b.assigned_user_id = "c";
        b.agent_email = "c@x.com";
      },
    });
    const err = await refusal(reassignBooking("bk1", "b@x.com", SYS, deps, { expect: expectOut }));
    assert(err instanceof RerouteRefusedError && err.code === "booking_moved", "a change landing mid move is refused as moved");
    assert(calls.reassignSwaps.length === 0, "the swap wrote nothing");
    assert(ctx.booking.assigned_user_id === "c", "so the advisor the other writer chose is not overwritten");
    const created = calls.createEvent.length;
    assert(created === 1, "the new advisor's event had been created");
    assert(
      calls.deleteEvent.length + calls.enqueueEventDeletion.length >= 1,
      "and it is rolled back rather than left on their calendar",
    );
  }

  // No expectation (every other reassign): unchanged behaviour, even mid change.
  {
    const ctx = { booking: makeBooking({ assigned_user_id: "c" }), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: cover });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.booking.assigned_user_id === "b", "a reassign with no expectation moves as before");
    assert(JSON.stringify(calls.reassignSwapExpects) === JSON.stringify([null]), "and hands the swap no expectation");
  }
}

await run();
finish();
