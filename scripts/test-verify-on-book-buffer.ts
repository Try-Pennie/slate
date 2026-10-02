// The live check at confirm time must ask Google about the BUFFERED window.
//
// The booker filters offered times through the event type's buffer before and
// after, so two calls on one advisor keep a gap (cal.com's 10 minute buffer, which
// was dropped in the move until 2026-10-02). But the last check before booking,
// verify-on-book, asked Google only about the call's own minutes. A meeting that
// reached the advisor's calendar after the cache was read, ending right as the new
// call starts or starting right as it ends, passed that check and the calls landed
// back to back, which is the stacking the buffer exists to stop.
// Run: node --experimental-strip-types scripts/test-verify-on-book-buffer.ts
import { createBooking, SlotUnavailableError } from "../src/lib/booking/orchestration.ts";
import type { EventType } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, input, eventType } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

// input books 13:00 to 13:30 (the fake event type runs 30 minutes).
const buffered = { ...eventType, buffer_before_min: 10, buffer_after_min: 10 } as EventType;
const endsAt = { start: "2026-06-08T13:30:00.000Z", end: "2026-06-08T13:50:00.000Z" };
const startsAt = { start: "2026-06-08T12:40:00.000Z", end: "2026-06-08T13:00:00.000Z" };

async function main() {
  // Positive control: with no buffer, a meeting starting as the call ends is no
  // conflict, so the first advisor is booked. Without this, a fake that called
  // everyone busy would pass the cases below.
  {
    const { deps } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      busyByEmail: new Map([["a@x.com", [endsAt]]]),
    });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "a", "no buffer: an adjacent meeting does not block the advisor");
  }

  // A meeting starting the minute the call would end is inside the buffer after.
  {
    const { deps } = makeDeps({
      eventType: buffered,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      busyByEmail: new Map([["a@x.com", [endsAt]]]),
    });
    const res = await createBooking(input, deps);
    assert(
      res.booking.assigned_user_id === "b",
      `buffer after: an advisor with a meeting right after the call is skipped (got ${res.booking.assigned_user_id})`,
    );
  }

  // A meeting ending the minute the call would start is inside the buffer before.
  {
    const { deps } = makeDeps({
      eventType: buffered,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      busyByEmail: new Map([["a@x.com", [startsAt]]]),
    });
    const res = await createBooking(input, deps);
    assert(
      res.booking.assigned_user_id === "b",
      `buffer before: an advisor with a meeting right before the call is skipped (got ${res.booking.assigned_user_id})`,
    );
  }

  // The only advisor has a meeting inside the buffer: the time is refused rather
  // than booked back to back.
  {
    const { deps, calls } = makeDeps({
      eventType: buffered,
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      busyByEmail: new Map([["a@x.com", [endsAt]]]),
    });
    let err: unknown = null;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, `buffer: the time is refused when nobody has the gap (got ${String(err)})`);
    assert(calls.createEvent.length === 0, "buffer: no calendar event is written for a refused time");
  }

  // After a lost race the next advisor is re-checked over the same buffered window.
  {
    const { deps } = makeDeps({
      eventType: buffered,
      candidates: ["a", "b", "c"],
      freeEmails: new Set(["a@x.com", "b@x.com", "c@x.com"]),
      busyByEmail: new Map([["b@x.com", [startsAt]]]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const res = await createBooking(input, deps);
    assert(
      res.booking.assigned_user_id === "c",
      `lost race: the next advisor is skipped when a meeting sits inside the buffer (got ${res.booking.assigned_user_id})`,
    );
  }
}

await main();
finish();
