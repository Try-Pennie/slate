import { describe, it, expect, vi, beforeEach } from "vitest";

// #1071: the prune-bookings-pii cron redacts the direct consumer contact data on
// bookings whose appointment is past the 24-month window (attendee name/email/
// phone + prefill), and prunes delivered booking_outbox rows. It deliberately
// does NOT clear salesforce_id/external_id (the external Salesforce reference) and
// does NOT touch the agent's Google Calendar (a completed meeting's event stays;
// only a real cancellation deletes it). This covers the route glue: auth + lock
// guards, the redaction UPDATE shape, the outbox delete, fail-loud, lock release.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
// #1118: redaction is export-gated (never redact a row Snowflake does not yet
// hold at full fidelity). Default the gate ready + a far-future export watermark
// so aged rows pass; individual tests override.
const gate = vi.hoisted(() => ({
  mirrorReadyForDeletion: vi.fn(async (): Promise<{ ready: boolean; reason: string | null }> => ({
    ready: true,
    reason: null,
  })),
  exportedThrough: vi.fn(async (_key: string): Promise<string | null> => "2099-01-01T00:00:00.000Z"),
}));

const rec = vi.hoisted(() => ({
  agedBookings: [] as Record<string, unknown>[],
  bookingUpdate: null as Record<string, unknown> | null,
  bookingUpdateIds: null as unknown,
  outboxDeleted: false,
  bookingSelectError: null as { message: string } | null,
  touchedTables: [] as string[],
}));

// A tiny table-aware builder. The route must only touch bookings + booking_outbox;
// any other table (users, pending_event_deletions) throws, proving retention
// never resolves an agent email or enqueues a calendar deletion.
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    rec.touchedTables.push(table);
    if (table === "bookings") {
      const b: Record<string, unknown> = {};
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
    if (table === "booking_outbox") {
      // Thenable so a multi-.lt() chain (created_at + the export-gate updated_at)
      // resolves on await, not on the first .lt().
      const b: Record<string, unknown> = {};
      b.delete = () => b;
      b.eq = () => b;
      b.lt = () => b;
      b.then = (resolve: (v: { error: null; count: number }) => unknown) => {
        rec.outboxDeleted = true;
        return resolve({ error: null, count: 3 });
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  }),
);

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/retention-gate", () => gate);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  gate.mirrorReadyForDeletion.mockResolvedValue({ ready: true, reason: null });
  gate.exportedThrough.mockResolvedValue("2099-01-01T00:00:00.000Z");
  rec.agedBookings = [];
  rec.bookingUpdate = null;
  rec.bookingUpdateIds = null;
  rec.outboxDeleted = false;
  rec.bookingSelectError = null;
  rec.touchedTables = [];
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

  it("redacts only the contact fields, keeps the external IDs, prunes the outbox, releases the lock", async () => {
    rec.agedBookings = [{ id: "bk1" }, { id: "bk2" }];

    const res = await GET(req());
    const body = await res.json();

    // Clears the direct contact data...
    expect(rec.bookingUpdate).toMatchObject({
      attendee_name: null,
      attendee_email: null,
      attendee_phone: null,
      prefill: {},
    });
    // ...but NEVER the external Salesforce reference.
    expect(rec.bookingUpdate).not.toHaveProperty("salesforce_id");
    expect(rec.bookingUpdate).not.toHaveProperty("external_id");
    expect(rec.bookingUpdateIds).toEqual(["bk1", "bk2"]);

    // Retention never resolves an agent or enqueues a calendar-event deletion.
    expect(rec.touchedTables).not.toContain("users");
    expect(rec.touchedTables).not.toContain("pending_event_deletions");

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
    expect(rec.outboxDeleted).toBe(true);
  });

  it("500s and releases the lock when the booking read errors (fail loud)", async () => {
    rec.bookingSelectError = { message: "boom" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });

  it("stamps pii_redacted_at so the export freezes the row (#1118, Flaw A)", async () => {
    rec.agedBookings = [{ id: "bk1" }];
    await GET(req());
    // Without this marker the redaction bumps updated_at and the export re-MERGEs
    // the blanked row over Snowflake's full-fidelity copy.
    expect(rec.bookingUpdate).toHaveProperty("pii_redacted_at");
    expect(typeof rec.bookingUpdate?.pii_redacted_at).toBe("string");
    expect(rec.bookingUpdate?.pii_redacted_at).not.toBeNull();
  });

  it("skips (redacts nothing) when the Snowflake mirror is not ready (#1118, export-gate)", async () => {
    gate.mirrorReadyForDeletion.mockResolvedValue({ ready: false, reason: "drift" });
    rec.agedBookings = [{ id: "bk1" }];
    const res = await GET(req());
    const body = await res.json();
    expect(body.skipped).toBe("mirror-not-ready");
    // Never redact (nor prune the outbox) while the warehouse copy is uncertain.
    expect(rec.bookingUpdate).toBeNull();
    expect(rec.outboxDeleted).toBe(false);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });
});
