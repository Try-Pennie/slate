import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Booking, Bucket, EventType } from "@/lib/db/types";

// #223/#871: the completion sweep silently dropped any booking whose
// bucket/event_type can't be resolved (a dropped booking never completes).
// joinBookingContexts is the choke point that sees the whole fetched batch AND
// performs the drop, so that condition is made loud there via the log helper.
// The other #223 condition (a full batch signalling a backlog) moved to the
// drain loop in completePastBookings (#871), which now clears the whole backlog
// per run, so joinBookingContexts no longer warns about the cap. These tests
// mock the log helper and assert the calls; they do NOT change the
// skip-unresolvable behavior itself.

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/log", () => ({ log: logMock }));

import { joinBookingContexts, PAST_COMPLETION_BATCH_LIMIT } from "./core";

const booking = (over: Partial<Booking>): Booking =>
  ({
    id: "b-1",
    bucket_id: "bucket-1",
    event_type_id: "evt-1",
    status: "confirmed",
    ...over,
  }) as unknown as Booking;

const bucket = (id: string): Bucket => ({ id }) as unknown as Bucket;
const eventType = (id: string): EventType => ({ id }) as unknown as EventType;

beforeEach(() => vi.clearAllMocks());

describe("joinBookingContexts loudness (#223/#871)", () => {
  it("no longer warns about a full batch: the drain loop clears it, not waits (#871)", () => {
    const bookings = Array.from({ length: PAST_COMPLETION_BATCH_LIMIT }, (_, i) =>
      booking({ id: `b-${i}` }),
    );

    const out = joinBookingContexts(
      bookings,
      [bucket("bucket-1")],
      [eventType("evt-1")],
    );

    // Behavior unchanged: every resolvable booking still comes through.
    expect(out).toHaveLength(PAST_COMPLETION_BATCH_LIMIT);

    // The cap warn relocated to completePastBookings; joinBookingContexts is
    // silent about batch size now.
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("surfaces an unresolvable booking (id + reason) instead of silently dropping it", () => {
    const resolvable = booking({ id: "b-ok" });
    const noBucket = booking({ id: "b-nobucket", bucket_id: "missing-bucket" });
    const noEventType = booking({
      id: "b-noevt",
      event_type_id: "missing-evt",
    });

    const out = joinBookingContexts(
      [resolvable, noBucket, noEventType],
      [bucket("bucket-1")],
      [eventType("evt-1")],
    );

    // Behavior unchanged: only the resolvable booking is returned.
    expect(out).toHaveLength(1);
    expect(out[0].booking.id).toBe("b-ok");

    // ...but each drop is now logged with its id and a reason.
    expect(logMock.error).toHaveBeenCalledTimes(2);
    const dropped = logMock.error.mock.calls.map(([tag, fields]) => {
      expect(tag).toBe("completion-sweep");
      return fields;
    });
    const byId = new Map(dropped.map((f) => [f.booking_id, f.reason]));
    expect(byId.get("b-nobucket")).toBe("bucket_missing");
    expect(byId.get("b-noevt")).toBe("event_type_missing");
  });
});
