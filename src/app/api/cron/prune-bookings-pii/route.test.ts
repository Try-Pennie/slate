import { describe, it, expect, vi, beforeEach } from "vitest";

// #1071: the prune-bookings-pii cron redacts consumer PII on bookings whose
// appointment is past the 24-month window: clears attendee fields + identity keys
// + prefill, enqueues deletion of the external Google Calendar event (via the
// crash-safe pending_event_deletions queue, #401), and prunes delivered
// booking_outbox rows. This covers the route glue: auth + lock guards, the
// redaction UPDATE shape, the gcal enqueue, the outbox delete, fail-loud, and
// lock release.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));

const rec = vi.hoisted(() => ({
  agedBookings: [] as Record<string, unknown>[],
  users: [] as Record<string, unknown>[],
  bookingUpdate: null as Record<string, unknown> | null,
  bookingUpdateIds: null as unknown,
  enqueued: [] as Record<string, unknown>[],
  outboxDeleted: false,
  bookingSelectError: null as { message: string } | null,
}));

// A tiny table-aware builder. Only the shapes this route uses are modeled.
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    if (table === "bookings") {
      const b: Record<string, unknown> = { _upd: null as Record<string, unknown> | null };
      b.select = () => b;
      b.lt = () => b;
      b.not = () => b;
      b.limit = () =>
        Promise.resolve({ data: rec.agedBookings, error: rec.bookingSelectError });
      b.update = (vals: Record<string, unknown>) => {
        rec.bookingUpdate = vals;
        return b;
      };
      b.in = (_col: string, ids: unknown) => {
        rec.bookingUpdateIds = ids;
        return Promise.resolve({ error: null, count: (ids as unknown[]).length });
      };
      return b;
    }
    if (table === "users") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.in = () => Promise.resolve({ data: rec.users, error: null });
      return b;
    }
    if (table === "pending_event_deletions") {
      return {
        upsert: (row: Record<string, unknown>) => {
          rec.enqueued.push(row);
          return Promise.resolve({ error: null });
        },
      };
    }
    if (table === "booking_outbox") {
      const b: Record<string, unknown> = {};
      b.delete = () => b;
      b.eq = () => b;
      b.lt = () => {
        rec.outboxDeleted = true;
        return Promise.resolve({ error: null, count: 3 });
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  }),
);

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  rec.agedBookings = [];
  rec.users = [];
  rec.bookingUpdate = null;
  rec.bookingUpdateIds = null;
  rec.enqueued = [];
  rec.outboxDeleted = false;
  rec.bookingSelectError = null;
});

describe("GET /api/cron/prune-bookings-pii", () => {
  it("401s and touches nothing when unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("skips when the lock is not acquired", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(await res.json()).toEqual({ skipped: "overlapping-run" });
    expect(from).not.toHaveBeenCalled();
  });

  it("redacts aged bookings, enqueues the gcal deletion, prunes the outbox, releases the lock", async () => {
    rec.agedBookings = [
      { id: "bk1", assigned_user_id: "u1", gcal_event_id: "ev1" },
      { id: "bk2", assigned_user_id: "u2", gcal_event_id: null },
    ];
    rec.users = [
      { id: "u1", email: "agent1@x.com" },
      { id: "u2", email: "agent2@x.com" },
    ];

    const res = await GET(req());
    const body = await res.json();

    // Both aged rows are redacted with the full PII+identity-key clear.
    expect(rec.bookingUpdate).toMatchObject({
      attendee_name: null,
      attendee_email: null,
      attendee_phone: null,
      salesforce_id: null,
      external_id: null,
    });
    expect(rec.bookingUpdateIds).toEqual(["bk1", "bk2"]);

    // Only the row with a calendar event is enqueued for external deletion.
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.enqueued[0]).toMatchObject({
      calendar_email: "agent1@x.com",
      gcal_event_id: "ev1",
      booking_id: "bk1",
    });

    expect(rec.outboxDeleted).toBe(true);
    expect(body.redacted).toBe(2);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });

  it("does nothing (but still prunes the outbox) when no bookings are aged", async () => {
    rec.agedBookings = [];
    const res = await GET(req());
    const body = await res.json();
    expect(body.redacted).toBe(0);
    expect(rec.bookingUpdate).toBeNull();
    expect(rec.enqueued).toHaveLength(0);
  });

  it("500s and releases the lock when the booking read errors (fail loud)", async () => {
    rec.bookingSelectError = { message: "boom" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });
});
