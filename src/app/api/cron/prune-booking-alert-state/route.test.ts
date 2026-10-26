import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the prune-booking-alert-state lane (#2726). The rule itself (which
// rows go, which stay, every failure throws) is pinned by the node suite in
// scripts/test-alert-state-retention.ts; this proves the route reads BOTH the
// cooldown rows and the firing markers, pages past one PostgREST page, deletes
// only what the rule chose, and turns a failed delete into a 500 with no heartbeat.

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const hb = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

const db = vi.hoisted(() => {
  const state = {
    alertKeys: new Set<string>(),
    bookings: new Map<string, { starts_at: string; created_at: string }>(),
    deleteError: null as { message: string } | null,
    deleted: [] as string[],
    patterns: [] as string[],
  };
  const PAGE = 1000;
  const matching = (pattern: string) => {
    const prefix = pattern.replace(/%$/, "").replace(/\\(.)/g, "$1");
    return [...state.alertKeys].filter((k) => k.startsWith(prefix)).sort();
  };
  const from = vi.fn((table: string) => {
    if (table === "alert_state") {
      return {
        select: () => ({
          like: (_col: string, pattern: string) => {
            state.patterns.push(pattern);
            // The keyset filter a paged read cuts each later page with (2026-10-25).
            let after: string | null = null;
            const q = {
              gt: (_c: string, v: string) => ((after = v), q),
              order: () => ({
                range: async (a: number, b: number) => ({
                  data: matching(pattern)
                    .filter((k) => after === null || k > after)
                    .slice(a, Math.min(b + 1, a + PAGE))
                    .map((key) => ({ key })),
                  error: null,
                }),
              }),
            };
            return q;
          },
        }),
        delete: () => ({
          in: async (_col: string, keys: string[]) => {
            if (state.deleteError) return { error: state.deleteError, count: null };
            let n = 0;
            for (const k of keys) if (state.alertKeys.delete(k)) n++;
            state.deleted.push(...keys);
            return { error: null, count: n };
          },
        }),
      };
    }
    if (table === "bookings") {
      return {
        select: () => ({
          in: async (_col: string, ids: string[]) => ({
            data: ids
              .filter((id) => state.bookings.has(id))
              .map((id) => ({ id, ...state.bookings.get(id)! })),
            error: null,
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { state, from };
});

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("@/lib/monitor/heartbeat", () => ({ recordHeartbeat: hb.recordHeartbeat }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];
const DAY = 24 * 60 * 60_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  vi.clearAllMocks();
  db.state.alertKeys = new Set();
  db.state.bookings = new Map();
  db.state.deleteError = null;
  db.state.deleted = [];
  db.state.patterns = [];
});

describe("GET /api/cron/prune-booking-alert-state (#2726)", () => {
  it("deletes both rows of every long past booking, across more than one page, and stamps its heartbeat", async () => {
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    const soon = new Date(Date.now() + DAY).toISOString();
    // 1,200 past bookings, so a single capped read would leave 200 behind.
    for (let i = 0; i < 1200; i++) {
      const id = uuid(i);
      db.state.bookings.set(id, { starts_at: old, created_at: old });
      db.state.alertKeys.add(`booking_offsite_origin:${id}`);
      db.state.alertKeys.add(`alert_firing:booking_offsite_origin:${id}`);
    }
    const upcoming = uuid(99_999);
    db.state.bookings.set(upcoming, { starts_at: soon, created_at: old });
    db.state.alertKeys.add(`stale_phone_invite:${upcoming}`);
    db.state.alertKeys.add("sync_failures");

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(2400);
    expect([...db.state.alertKeys].sort()).toEqual(["stale_phone_invite:" + upcoming, "sync_failures"].sort());
    // Both halves of every family were asked for, with `_` escaped for LIKE.
    expect(db.state.patterns).toContain("booking\\_offsite\\_origin:%");
    expect(db.state.patterns).toContain("alert\\_firing:booking\\_offsite\\_origin:%");
    expect(hb.recordHeartbeat).toHaveBeenCalledWith("prune-booking-alert-state");
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_booking_alert_state", "lease");
  });

  it("answers 500 and stamps no heartbeat when the delete fails, so the watchdog pages", async () => {
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    db.state.bookings.set(uuid(1), { starts_at: old, created_at: old });
    db.state.alertKeys.add(`booking_offsite_origin:${uuid(1)}`);
    db.state.deleteError = { message: "permission denied" };

    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/permission denied/);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalled();
  });

  it("refuses an unauthorized caller before touching anything", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });
});
