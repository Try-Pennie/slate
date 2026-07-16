import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Booking, Bucket, EventType } from "@/lib/db/types";

// #223: the completion sweep silently caps at 200 finished bookings per run and
// silently drops any booking whose bucket/event_type can't be resolved. Both are
// fine at current volume but invisible when they bite (a backlog over the cap
// quietly waits; a dropped booking never completes). joinBookingContexts is the
// choke point that sees the whole fetched batch AND performs the drop, so both
// conditions are made loud there via the log helper. These tests mock the helper
// and assert the calls; they do NOT change the cap-at-200 / skip-unresolvable
// behavior itself.

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

describe("joinBookingContexts loudness (#223)", () => {
  it("warns when the fetched batch fills the cap (a backlog is likely waiting)", () => {
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

    // ...but the full batch is now observable as a warn line.
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    const [tag, fields] = logMock.warn.mock.calls[0];
    expect(tag).toBe("completion-sweep");
    expect(fields).toMatchObject({
      count: PAST_COMPLETION_BATCH_LIMIT,
      cap: PAST_COMPLETION_BATCH_LIMIT,
    });
  });

  it("does not warn about the cap for a partial (under-cap) batch", () => {
    joinBookingContexts(
      [booking({ id: "b-a" })],
      [bucket("bucket-1")],
      [eventType("evt-1")],
    );
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
