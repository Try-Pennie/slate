import { describe, it, expect, vi, beforeEach } from "vitest";

// #2369: the wiring between the duplicate-cancel route and the one database call
// that decides. Three things live here and nowhere else, and each is a way this path
// could quietly do the wrong thing:
//
//  - a call that FAILED, or a reply that could not be read, must never be reported as
//    a refusal, and must never record a handoff about a decision nobody made;
//  - a refusal that needs a person must be recorded BEFORE it is reported, and a
//    failed write must be loud, because "refused, and somebody has been told" when
//    nobody has is the silence booking_handoffs exists to end;
//  - a committed cancel must run its outbox row inline, and a failure THERE must not
//    fail the request: the row is durable and the drain finishes it.
//
// The database is a hand written fake, so every one of those is produced by a case.
const admin = vi.hoisted(() => {
  const rpc = vi.fn();
  const outboxRow = { value: null as unknown };
  const client = {
    rpc,
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => outboxRow.value,
        }),
      }),
    }),
  };
  return { rpc, outboxRow, supabaseAdmin: vi.fn(() => client) };
});
const handoffs = vi.hoisted(() => ({ handoffWriter: vi.fn() }));
const lease = vi.hoisted(() => ({
  leaseOutboxRow: vi.fn(async (): Promise<string | null> => "lease-1"),
  releaseOutboxLeaseRow: vi.fn(async () => {}),
  saveOutboxStepsRow: vi.fn(async () => "written"),
  markOutboxDeliveredRow: vi.fn(async () => "written"),
}));
const outbox = vi.hoisted(() => ({
  runOutboxSteps: vi.fn(
    async (
      _deps: unknown,
      _row: { id: string; action: string },
      _handlers?: unknown,
      _lease?: string,
    ): Promise<{ delivered: boolean; ran: string[]; failed: string[]; stopped: string | null }> => ({
      delivered: true,
      ran: [],
      failed: [],
      stopped: null,
    }),
  ),
  processBookingOutbox: vi.fn(),
  everyLeasedRowStoodDown: vi.fn(),
  OUTBOX_DRAIN_CONCURRENCY: 8,
}));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: admin.supabaseAdmin }));
vi.mock("@/lib/handoffs/store", () => handoffs);
vi.mock("@/lib/booking/outbox-lease", () => lease);
vi.mock("@/lib/booking/outbox", () => outbox);

import { cancelDuplicateBooking } from "@/lib/booking/service";
import { DuplicateCancelUnavailableError } from "@/lib/booking/duplicate-cancel";

/** A writer with the constraint the database has: one OPEN row per (booking, kind). */
function fakeWriter() {
  const rows: { booking_id: string; kind: string; detail: Record<string, unknown> }[] = [];
  let failWith: Error | null = null;
  return {
    rows,
    failNext: (err: Error) => {
      failWith = err;
    },
    writer: {
      insertOnce: async (row: { booking_id: string; kind: string; detail: Record<string, unknown> }) => {
        if (failWith) throw failWith;
        if (rows.some((r) => r.booking_id === row.booking_id && r.kind === row.kind)) {
          return { inserted: false };
        }
        rows.push(row);
        return { inserted: true };
      },
    },
  };
}

let writer: ReturnType<typeof fakeWriter>;

beforeEach(() => {
  vi.clearAllMocks();
  writer = fakeWriter();
  handoffs.handoffWriter.mockReturnValue(writer.writer);
  admin.outboxRow.value = { data: null, error: null };
  lease.leaseOutboxRow.mockResolvedValue("lease-1");
  outbox.runOutboxSteps.mockResolvedValue({ delivered: true, ran: [], failed: [], stopped: null });
});

const reply = (data: unknown) => admin.rpc.mockResolvedValue({ data, error: null });

describe("what it asks the database", () => {
  it("names the booking and pins the instant, rather than letting the database read its own clock", async () => {
    reply({ outcome: "no-other-call", candidateIds: [], weakerMatch: null });
    await cancelDuplicateBooking({
      bookingId: "bk-1",
      laterBookingStartsAt: null,
      nowMs: Date.parse("2026-09-16T12:00:00.000Z"),
    });
    expect(admin.rpc).toHaveBeenCalledWith("cancel_duplicate_booking", {
      p_booking_id: "bk-1",
      p_now: "2026-09-16T12:00:00.000Z",
    });
  });
});

describe("a call that could not be made", () => {
  it("throws at the rpc stage and records NOTHING", async () => {
    admin.rpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    await expect(
      cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null }),
    ).rejects.toMatchObject({ name: "DuplicateCancelUnavailableError", stage: "rpc" });
    expect(writer.rows).toHaveLength(0);
  });

  it("throws at the rpc stage when the call itself rejects", async () => {
    admin.rpc.mockRejectedValue(new Error("connection reset"));
    await expect(
      cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null }),
    ).rejects.toBeInstanceOf(DuplicateCancelUnavailableError);
    expect(writer.rows).toHaveLength(0);
  });

  it("throws at the result stage on a reply it cannot read, and records nothing", async () => {
    reply({ outcome: "something-new" });
    await expect(
      cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null }),
    ).rejects.toMatchObject({ stage: "result" });
    expect(writer.rows).toHaveLength(0);
  });

  it("throws at the result stage on a cancel with no outbox row, so a cancel whose side effects were never enqueued is never reported as done", async () => {
    reply({ outcome: "cancelled", candidateIds: ["bk-2"], weakerMatch: null });
    await expect(
      cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null }),
    ).rejects.toMatchObject({ stage: "result" });
  });
});

describe("recording the refusal", () => {
  it("writes the finding, the weaker match and the reported time exactly as sent", async () => {
    reply({ outcome: "no-other-call", candidateIds: [], weakerMatch: "phone-only" });
    const out = await cancelDuplicateBooking({
      bookingId: "bk-1",
      laterBookingStartsAt: "2026-09-17T15:00:00.000Z",
    });
    expect(out.handoff).toBe("recorded");
    expect(writer.rows).toEqual([
      {
        booking_id: "bk-1",
        kind: "duplicate-unresolved",
        detail: {
          finding: "no-other-call",
          weakerMatch: "phone-only",
          laterBookingStartsAt: "2026-09-17T15:00:00.000Z",
        },
      },
    ]);
  });

  it.each([
    ["named-is-newest"],
    ["identity-conflict"],
  ])("records %s too", async (outcome) => {
    reply({ outcome, candidateIds: ["bk-2"], weakerMatch: null });
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.handoff).toBe("recorded");
    expect(writer.rows[0].detail).toMatchObject({ finding: outcome, weakerMatch: null });
  });

  it("tells a retried caller the row was already open rather than opening a second", async () => {
    reply({ outcome: "no-other-call", candidateIds: [], weakerMatch: null });
    await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    const again = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(again.handoff).toBe("already-recorded");
    expect(writer.rows).toHaveLength(1);
  });

  it("throws at the handoff stage when the write fails, rather than reporting a refusal nobody heard", async () => {
    reply({ outcome: "no-other-call", candidateIds: [], weakerMatch: null });
    writer.failNext(new Error("booking handoff write failed: deadlock detected"));
    await expect(
      cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null }),
    ).rejects.toMatchObject({ stage: "handoff" });
  });

  it.each([["not-found"], ["not-active"], ["started"]])(
    "records nothing on %s, because nobody is waiting on a person",
    async (outcome) => {
      reply({ outcome, candidateIds: [], weakerMatch: null });
      const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
      expect(out.handoff).toBeNull();
      expect(writer.rows).toHaveLength(0);
    },
  );

  it("records nothing on a cancel", async () => {
    reply({ outcome: "cancelled", outboxId: "ob-1", candidateIds: ["bk-2"], weakerMatch: null });
    admin.outboxRow.value = { data: outboxRowData(), error: null };
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.handoff).toBeNull();
    expect(writer.rows).toHaveLength(0);
  });
});

function outboxRowData() {
  return {
    id: "ob-1",
    booking_id: "bk-1",
    action: "cancel",
    status: "pending",
    steps: [{ name: "cancel:gcal_delete", state: "pending" }],
    payload: { reasonCode: "double_booking", initiator: "system" },
    lease_until: null,
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: "2026-09-16T12:00:00.000Z",
    updated_at: "2026-09-16T12:00:00.000Z",
  };
}

describe("delivering the cancel", () => {
  it("leases the row the database wrote, runs it, and releases the lease", async () => {
    reply({ outcome: "cancelled", outboxId: "ob-1", candidateIds: ["bk-2"], weakerMatch: null });
    admin.outboxRow.value = { data: outboxRowData(), error: null };
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.delivered).toBe(true);
    expect(lease.leaseOutboxRow).toHaveBeenCalled();
    // The row it runs is the one the FUNCTION wrote, never a second copy built here.
    expect(outbox.runOutboxSteps.mock.calls[0][1]).toMatchObject({ id: "ob-1", action: "cancel" });
    expect(lease.releaseOutboxLeaseRow).toHaveBeenCalled();
  });

  it("stands down when a drain tick already holds the row", async () => {
    reply({ outcome: "cancelled", outboxId: "ob-1", candidateIds: [], weakerMatch: null });
    admin.outboxRow.value = { data: outboxRowData(), error: null };
    lease.leaseOutboxRow.mockResolvedValue(null);
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.delivered).toBeNull();
    expect(outbox.runOutboxSteps).not.toHaveBeenCalled();
  });

  it("still answers cancelled when the inline run throws, because the row is durable and the drain finishes it", async () => {
    reply({ outcome: "cancelled", outboxId: "ob-1", candidateIds: [], weakerMatch: null });
    admin.outboxRow.value = { data: outboxRowData(), error: null };
    outbox.runOutboxSteps.mockRejectedValue(new Error("google is down"));
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.result.outcome).toBe("cancelled");
    expect(out.delivered).toBeNull();
  });

  it("still answers cancelled when the outbox row cannot be read back", async () => {
    reply({ outcome: "cancelled", outboxId: "ob-1", candidateIds: [], weakerMatch: null });
    admin.outboxRow.value = { data: null, error: { message: "timeout" } };
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.result.outcome).toBe("cancelled");
    expect(out.delivered).toBeNull();
    expect(outbox.runOutboxSteps).not.toHaveBeenCalled();
  });

  it("runs nothing at all on a refusal", async () => {
    reply({ outcome: "named-is-newest", candidateIds: ["bk-2"], weakerMatch: null });
    await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(lease.leaseOutboxRow).not.toHaveBeenCalled();
    expect(outbox.runOutboxSteps).not.toHaveBeenCalled();
  });

  it("runs nothing on a retry after a success: there is no second row to run", async () => {
    reply({ outcome: "already-cancelled", candidateIds: [], weakerMatch: null });
    const out = await cancelDuplicateBooking({ bookingId: "bk-1", laterBookingStartsAt: null });
    expect(out.result.outcome).toBe("already-cancelled");
    expect(outbox.runOutboxSteps).not.toHaveBeenCalled();
    expect(writer.rows).toHaveLength(0);
  });
});
