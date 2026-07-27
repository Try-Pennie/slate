import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the prune-routing cron. Since #1102 it is EXPORT-GATED: it deletes
// routing_decisions older than the retention window AND only up to the confirmed
// Snowflake-export watermark, and only when a reconciliation currently passes.
// This covers the route glue: auth guard, lock guard, the mirror-ready + exported
// gates, the delete shape (lt cutoff + lte watermark), lock release, and response.
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
  exportedThrough: vi.fn(async (): Promise<string | null> => "2026-01-01T00:00:00Z"),
}));
const lte = vi.hoisted(() =>
  vi.fn(async (): Promise<{ error: { message: string } | null; count: number | null }> => ({ error: null, count: 0 })),
);
const lt = vi.hoisted(() => vi.fn(() => ({ lte })));
const del = vi.hoisted(() => vi.fn(() => ({ lt })));
const from = vi.hoisted(() => vi.fn(() => ({ delete: del })));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/retention-gate", () => gate);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  gate.mirrorReadyForDeletion.mockResolvedValue({ ready: true, reason: null });
  gate.exportedThrough.mockResolvedValue("2026-01-01T00:00:00Z");
  lte.mockResolvedValue({ error: null, count: 0 });
});

describe("GET /api/cron/prune-routing (export-gated, #1102)", () => {
  it("returns 401 and does not delete when the request is unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("skips (no delete) when the lock is not acquired", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(await res.json()).toEqual({ skipped: "overlapping-run" });
    expect(from).not.toHaveBeenCalled();
  });

  it("skips WITHOUT deleting when the mirror is not ready for deletion", async () => {
    gate.mirrorReadyForDeletion.mockResolvedValueOnce({ ready: false, reason: "mirror not configured" });
    const res = await GET(req());
    expect((await res.json()).skipped).toBe("mirror-not-ready");
    expect(gate.exportedThrough).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("skips when nothing has been exported yet", async () => {
    gate.exportedThrough.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect((await res.json()).skipped).toBe("nothing-exported-yet");
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes with a ~12-month cutoff AND the confirmed-export watermark, then releases the lock", async () => {
    lte.mockResolvedValueOnce({ error: null, count: 7 });
    const beforeMs = Date.now();
    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pruned).toBe(7);
    expect(body.exportedThrough).toBe("2026-01-01T00:00:00Z");

    expect(from).toHaveBeenCalledWith("routing_decisions");
    expect(del).toHaveBeenCalledWith({ count: "exact" });

    // lt uses created_at with a ~12-month cutoff...
    const [ltField, cutoffIso] = lt.mock.calls[0] as unknown as [string, string];
    expect(ltField).toBe("created_at");
    const elapsedMs = beforeMs - new Date(cutoffIso).getTime();
    expect(elapsedMs).toBeGreaterThan(11 * 30 * 24 * 60 * 60 * 1000);
    expect(elapsedMs).toBeLessThan(13 * 30 * 24 * 60 * 60 * 1000);
    // ...and lte bounds the delete by the confirmed-export watermark.
    expect(lte).toHaveBeenCalledWith("created_at", "2026-01-01T00:00:00Z");

    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_routing", "lease");
  });

  it("returns 500 when the DB delete fails and still releases the lock", async () => {
    lte.mockResolvedValueOnce({ error: { message: "db exploded" }, count: null });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("db exploded");
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
