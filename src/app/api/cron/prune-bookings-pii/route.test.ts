import { describe, it, expect, vi, beforeEach } from "vitest";

// #1071: the prune-bookings-pii cron redacts the direct consumer contact data on
// bookings whose appointment is past the 24-month window (attendee name/email/
// phone + prefill), and prunes delivered booking_outbox rows. It deliberately does
// NOT clear salesforce_id/external_id (the external Salesforce reference) and does
// NOT touch the agent's Google Calendar (a completed meeting's event stays; only a
// real cancellation deletes it).
//
// Since #1102 both destructive halves are VERIFY-GATED: each reads a bounded batch
// and asks the warehouse, per id, whether it holds that row at a current version.
// booking_outbox needs this MOST, because it has no set_updated_at trigger, so its
// writers stamp updated_at from the Worker's own clock; a row committed with an
// earlier stamp after the cursor passed it is never exported yet still satisfies
// the watermark predicate. Only asking the warehouse catches that.
//
// The REAL verifier runs here; only the Snowflake transport is stubbed.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const gate = vi.hoisted(() => ({
  mirrorReadyForDeletion: vi.fn(async (): Promise<{ ready: boolean; reason: string | null }> => ({
    ready: true,
    reason: null,
  })),
  exportedThrough: vi.fn(async (_key: string): Promise<string | null> => "2099-01-01T00:00:00.000Z"),
}));
const sf = vi.hoisted(() => ({ executeStatement: vi.fn() }));

const rec = vi.hoisted(() => ({
  agedBookings: [] as Record<string, unknown>[],
  agedOutbox: [] as Record<string, unknown>[],
  bookingUpdate: null as Record<string, unknown> | null,
  bookingUpdateIds: null as unknown,
  outboxDeletedIds: null as unknown,
  bookingSelectError: null as { message: string } | null,
  outboxSelectError: null as { message: string } | null,
  touchedTables: [] as string[],
  bookingLimits: [] as number[],
  outboxLimits: [] as number[],
}));

// A tiny table-aware builder. The route must only touch bookings + booking_outbox;
// any other table (users, pending_event_deletions) throws, proving retention never
// resolves an agent email or enqueues a calendar deletion.
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    rec.touchedTables.push(table);
    if (table === "bookings") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.lt = () => b;
      b.not = () => b;
      b.order = () => b;
      b.limit = (n: number) => {
        rec.bookingLimits.push(n);
        return Promise.resolve({ data: rec.agedBookings, error: rec.bookingSelectError });
      };
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
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.lt = () => b;
      b.order = () => b;
      b.limit = (n: number) => {
        rec.outboxLimits.push(n);
        return Promise.resolve({ data: rec.agedOutbox, error: rec.outboxSelectError });
      };
      b.delete = () => b;
      b.in = (_col: string, ids: unknown) => {
        rec.outboxDeletedIds = ids;
        return Promise.resolve({ error: null, count: (ids as unknown[]).length });
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  }),
);

const hb = vi.hoisted(() => ({
  recordHeartbeat: vi.fn(async () => {}),
  sendThrottledAlert: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/retention-gate", () => gate);
vi.mock("@/lib/snowflake/config", () => ({
  readSnowflakeConfig: () => ({
    account: "a",
    user: "u",
    privateKeyPem: "k",
    database: "SLATE",
    schema: "PUBLIC",
    warehouse: "SLATE_WH",
    role: "SLATE_ROLE",
  }),
}));
vi.mock("@/lib/snowflake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/snowflake/client")>()),
  executeStatement: sf.executeStatement,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/monitor/heartbeat", () => ({ recordHeartbeat: hb.recordHeartbeat }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: hb.sendThrottledAlert }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

/** Answer every verify statement by echoing back the ids it named. */
const answerFromStatement = (opts: { present?: boolean; current?: boolean } = {}) =>
  sf.executeStatement.mockImplementation(async (_cfg: unknown, statement: string) => {
    const ids = [...String(statement).matchAll(/\('([^']+)', '[^']*'\)/g)].map((m) => m[1]);
    return { data: ids.map((id) => [id, String(opts.present ?? true), String(opts.current ?? true)]) };
  });

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  gate.mirrorReadyForDeletion.mockResolvedValue({ ready: true, reason: null });
  gate.exportedThrough.mockResolvedValue("2099-01-01T00:00:00.000Z");
  rec.agedBookings = [];
  rec.agedOutbox = [];
  rec.bookingUpdate = null;
  rec.bookingUpdateIds = null;
  rec.outboxDeletedIds = null;
  rec.bookingSelectError = null;
  rec.outboxSelectError = null;
  rec.touchedTables = [];
  rec.bookingLimits = [];
  rec.outboxLimits = [];
  answerFromStatement();
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
    rec.agedBookings = [
      { id: "bk1", updated_at: "2026-01-01T00:00:00Z" },
      { id: "bk2", updated_at: "2026-01-02T00:00:00Z" },
    ];
    rec.agedOutbox = [{ id: "ob1", updated_at: "2026-01-01T00:00:00Z" }];

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

    expect(rec.outboxDeletedIds).toEqual(["ob1"]);
    expect(body.redacted).toBe(2);
    expect(body.outboxPruned).toBe(1);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });

  it("bounds BOTH candidate reads, since bookings and booking_outbox are growth tables", async () => {
    await GET(req());
    expect(rec.bookingLimits[0]).toBeGreaterThan(0);
    expect(rec.outboxLimits[0]).toBeGreaterThan(0);
  });

  it("does nothing (but still prunes the outbox) when no bookings are aged", async () => {
    rec.agedBookings = [];
    rec.agedOutbox = [{ id: "ob1", updated_at: "2026-01-01T00:00:00Z" }];
    const res = await GET(req());
    const body = await res.json();
    expect(body.redacted).toBe(0);
    expect(rec.bookingUpdate).toBeNull();
    expect(body.outboxPruned).toBe(1);
  });

  it("succeeds with nothing done on a genuinely quiet day, without calling the warehouse", async () => {
    rec.agedBookings = [];
    rec.agedOutbox = [];
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.redacted).toBe(0);
    expect(body.outboxPruned).toBe(0);
    expect(sf.executeStatement).not.toHaveBeenCalled();
  });

  it("500s and releases the lock when the booking read errors (fail loud)", async () => {
    rec.bookingSelectError = { message: "boom" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });

  it("stamps pii_redacted_at so the export freezes the row (#1118, Flaw A)", async () => {
    rec.agedBookings = [{ id: "bk1", updated_at: "2026-01-01T00:00:00Z" }];
    await GET(req());
    // Without this marker the redaction bumps updated_at and the export re-MERGEs
    // the blanked row over Snowflake's full-fidelity copy.
    expect(rec.bookingUpdate).toHaveProperty("pii_redacted_at");
    expect(typeof rec.bookingUpdate?.pii_redacted_at).toBe("string");
  });

  it("skips (redacts nothing) when the Snowflake mirror is not ready (#1118, export-gate)", async () => {
    gate.mirrorReadyForDeletion.mockResolvedValue({ ready: false, reason: "drift" });
    rec.agedBookings = [{ id: "bk1", updated_at: "2026-01-01T00:00:00Z" }];
    const res = await GET(req());
    const body = await res.json();
    expect(body.skipped).toBe("mirror-not-ready");
    // Never redact (nor prune the outbox) while the warehouse copy is uncertain.
    expect(rec.bookingUpdate).toBeNull();
    expect(rec.outboxDeletedIds).toBeNull();
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_bookings_pii", "lease");
  });

  it("500s and redacts NOTHING when the warehouse confirms none of the aged bookings", async () => {
    rec.agedBookings = [{ id: "bk1", updated_at: "2026-01-01T00:00:00Z" }];
    answerFromStatement({ present: false, current: false });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/confirmed NONE/);
    expect(rec.bookingUpdate).toBeNull();
  });

  it("500s and deletes NO outbox rows when the warehouse confirms none of them", async () => {
    // The dangerous case: booking_outbox has no updated_at trigger, so a row can
    // pass the watermark predicate while never having reached the warehouse.
    rec.agedBookings = [];
    rec.agedOutbox = [{ id: "ob1", updated_at: "2026-01-01T00:00:00Z" }];
    answerFromStatement({ present: false, current: false });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/confirmed NONE/);
    expect(rec.outboxDeletedIds).toBeNull();
  });

  it("500s and destroys nothing when the warehouse read itself fails", async () => {
    rec.agedBookings = [{ id: "bk1", updated_at: "2026-01-01T00:00:00Z" }];
    sf.executeStatement.mockRejectedValue(new Error("warehouse suspended"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/warehouse suspended/);
    expect(rec.bookingUpdate).toBeNull();
    expect(rec.outboxDeletedIds).toBeNull();
  });
});
