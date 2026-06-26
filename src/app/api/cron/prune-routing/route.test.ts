import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the prune-routing cron: deletes routing_decisions rows older than
// the configured retention window. The retention logic (pruneCutoffIso) is
// exercised inline here; this covers only the route glue: auth guard, lock
// guard, DB delete shape, lock release, and response.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const lt = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ error: { message: string } | null; count: number | null }> => ({
      error: null,
      count: 0,
    }),
  ),
);
const del = vi.hoisted(() => vi.fn(() => ({ lt })));
const from = vi.hoisted(() => vi.fn(() => ({ delete: del })));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from }),
}));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  lt.mockResolvedValue({ error: null, count: 0 });
});

describe("GET /api/cron/prune-routing", () => {
  it("returns 401 and does not delete when the request is unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("skips the delete and returns a skipped response when the lock is not acquired", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    const body = await res.json();
    expect(body).toEqual({ skipped: "overlapping-run" });
    expect(from).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("calls delete with a ~12-month cutoff, releases the lock, and returns the pruned count", async () => {
    lt.mockResolvedValueOnce({ error: null, count: 7 });
    const beforeMs = Date.now();
    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pruned).toBe(7);

    // Delete was issued against the correct table
    expect(from).toHaveBeenCalledWith("routing_decisions");
    expect(del).toHaveBeenCalledWith({ count: "exact" });

    // The lt filter uses "created_at" and a cutoff approximately 12 months ago
    expect(lt).toHaveBeenCalledTimes(1);
    const ltCalls = lt.mock.calls as unknown as [string, string][];
    const [field, cutoffIso] = ltCalls[0];
    expect(field).toBe("created_at");

    const cutoffMs = new Date(cutoffIso).getTime();
    const elapsedMs = beforeMs - cutoffMs;
    const elevenMonthsMs = 11 * 30 * 24 * 60 * 60 * 1000;
    const thirteenMonthsMs = 13 * 30 * 24 * 60 * 60 * 1000;
    expect(elapsedMs).toBeGreaterThan(elevenMonthsMs);
    expect(elapsedMs).toBeLessThan(thirteenMonthsMs);

    // Lock is always released (finally block)
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_routing", "lease");
  });

  it("returns 500 when the DB delete fails and still releases the lock", async () => {
    lt.mockResolvedValueOnce({ error: { message: "db exploded" }, count: null });
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db exploded");
    // Lock still released even on error (finally block)
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
