import { describe, it, expect, vi, beforeEach } from "vitest";

// #1128: the operator-triggered warehouse purge. This covers the route glue, and
// the part worth covering most is the DENIALS: the endpoint blanks columns in the
// archive, so who may call it and what it may touch are the two things that must
// not regress (and #676 established that denial coverage is a requirement here,
// not an extra).
const auth = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const purge = vi.hoisted(() => ({ purgeSnowflakeErasure: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/purge", () => purge);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

const req = (body?: unknown) =>
  ({
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  }) as unknown as Parameters<typeof POST>[0];

const clean = {
  ok: true,
  bookingIds: ["b1"],
  rowsByTable: { bookings: 1, booking_events: 1, webhook_deliveries: 3, booking_outbox: 1 },
  residualAfter: { bookings: 0, booking_events: 0, webhook_deliveries: 0, booking_outbox: 0 },
  reasons: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
  cron.isAuthorizedCron.mockReturnValue(false);
  locks.acquireLock.mockResolvedValue("lease");
  purge.purgeSnowflakeErasure.mockResolvedValue(clean);
});

describe("POST /api/admin/erasure-purge", () => {
  describe("who may call it", () => {
    it("403s a caller who is neither an admin nor an operator, and purges nothing", async () => {
      auth.requireAdmin.mockRejectedValue(new Error("not authorized"));
      const res = await POST(req());
      expect(res.status).toBe(403);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
      expect(locks.acquireLock).not.toHaveBeenCalled();
    });

    it("403s a signed-in non-admin (requireAdmin is the gate, not merely being logged in)", async () => {
      auth.requireAdmin.mockRejectedValue(new Error("not authorized"));
      cron.isAuthorizedCron.mockReturnValue(false);
      const res = await POST(req({ bookingIds: ["b1"] }));
      expect(res.status).toBe(403);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
    });

    it("allows an admin and records them as the actor", async () => {
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(purge.purgeSnowflakeErasure).toHaveBeenCalledWith(undefined, "admin-1");
    });

    it("allows an operator process holding the secret, with no actor", async () => {
      auth.requireAdmin.mockRejectedValue(new Error("not authorized"));
      cron.isAuthorizedCron.mockReturnValue(true);
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(purge.purgeSnowflakeErasure).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe("what it may touch", () => {
    it("passes an explicit booking id list through", async () => {
      await POST(req({ bookingIds: ["b1", "b2"] }));
      expect(purge.purgeSnowflakeErasure).toHaveBeenCalledWith(["b1", "b2"], "admin-1");
    });

    it("400s a bookingIds that is not an array of strings", async () => {
      const res = await POST(req({ bookingIds: [1, 2] }));
      expect(res.status).toBe(400);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
    });

    it("400s (not 500s) an id that no erasure has been recorded for", async () => {
      purge.purgeSnowflakeErasure.mockRejectedValue(
        new Error("erasure purge: 1 booking id(s) have not been erased in Supabase, so their warehouse copy must not be blanked: b9"),
      );
      const res = await POST(req({ bookingIds: ["b9"] }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/have not been erased/);
    });
  });

  describe("reporting what happened", () => {
    it("returns the row counts and the post-purge verify", async () => {
      const res = await POST(req());
      expect(await res.json()).toMatchObject({ ok: true, rowsByTable: { webhook_deliveries: 3 } });
    });

    it("does NOT report success when the purge ran but left a residual", async () => {
      purge.purgeSnowflakeErasure.mockResolvedValue({
        ...clean,
        ok: false,
        residualAfter: { ...clean.residualAfter, webhook_deliveries: 3 },
        reasons: ["webhook_deliveries: 3 row(s) still hold contact PII after the purge"],
      });
      const res = await POST(req());
      expect(res.status).toBe(500);
      expect((await res.json()).ok).toBe(false);
    });

    it("500s and releases the lock when a statement fails", async () => {
      purge.purgeSnowflakeErasure.mockRejectedValue(new Error("Snowflake 400: invalid identifier"));
      const res = await POST(req());
      expect(res.status).toBe(500);
      expect(locks.releaseLock).toHaveBeenCalledWith("erasure_warehouse_purge", "lease");
    });
  });

  describe("concurrency", () => {
    it("409s rather than running two purges at once", async () => {
      locks.acquireLock.mockResolvedValue(null);
      const res = await POST(req());
      expect(res.status).toBe(409);
      expect(purge.purgeSnowflakeErasure).not.toHaveBeenCalled();
    });

    it("releases the lock on the happy path too", async () => {
      await POST(req());
      expect(locks.releaseLock).toHaveBeenCalledWith("erasure_warehouse_purge", "lease");
    });
  });
});
