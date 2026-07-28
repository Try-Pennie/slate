import { describe, it, expect, vi, beforeEach } from "vitest";

// #1073: the prune-webhook-payloads cron blanks webhook_deliveries.payload (full
// attendee PII) on deliveries that are terminal (success, or failed past the retry
// cap) and older than the 90-day retention window, and sets payload_erased so no
// send path re-delivers the blanked row.
//
// Since #1102 it is VERIFY-GATED: blanking is irreversible for the payload, so it
// needs the same proof a delete does. The lane reads a BOUNDED batch of candidates
// (this table is already past PostgREST's 1000-row page cap, so an unbounded read
// would silently see part of the set), asks the warehouse per id whether it holds
// that row at a current version, and blanks ONLY the confirmed ids.
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
const db = vi.hoisted(() => {
  const state = {
    candidates: [] as { id: string; updated_at: string }[],
    readError: null as { message: string } | null,
    updateError: null as { message: string } | null,
    updatedIds: [] as string[],
    update: null as Record<string, unknown> | null,
    filters: [] as { fn: string; args: unknown[] }[],
    limitCalls: [] as number[],
  };
  const chain: Record<string, unknown> = {};
  const record = (fn: string) => (...args: unknown[]) => {
    state.filters.push({ fn, args });
    return chain;
  };
  chain.select = () => chain;
  chain.eq = record("eq");
  chain.or = record("or");
  chain.lt = record("lt");
  chain.order = () => chain;
  chain.limit = (n: number) => {
    state.limitCalls.push(n);
    return Promise.resolve({ data: state.candidates, error: state.readError });
  };
  chain.update = (vals: Record<string, unknown>) => {
    state.update = vals;
    return {
      in: (_col: string, ids: string[]) => {
        state.updatedIds = ids;
        return Promise.resolve({ error: state.updateError, count: state.updateError ? null : ids.length });
      },
    };
  };
  const from = vi.fn(() => chain);
  return { state, from };
});

const hb = vi.hoisted(() => ({
  recordHeartbeat: vi.fn(async () => {}),
  sendThrottledAlert: vi.fn(async () => {}),
}));

const rx = vi.hoisted(() => ({ repairUnverified: vi.fn(async () => 0) }));

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
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("@/lib/monitor/heartbeat", () => ({ recordHeartbeat: hb.recordHeartbeat }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: hb.sendThrottledAlert }));
vi.mock("@/lib/snowflake/reexport", () => ({ repairUnverified: rx.repairUnverified }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];
const warehouseHolds = (ids: string[], opts: { present?: boolean; current?: boolean } = {}) => ({
  data: ids.map((id) => [id, String(opts.present ?? true), String(opts.current ?? true)]),
});

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  gate.mirrorReadyForDeletion.mockResolvedValue({ ready: true, reason: null });
  gate.exportedThrough.mockResolvedValue("2099-01-01T00:00:00.000Z");
  db.state.candidates = [];
  db.state.readError = null;
  db.state.updateError = null;
  db.state.updatedIds = [];
  db.state.update = null;
  db.state.filters = [];
  db.state.limitCalls = [];
});

describe("GET /api/cron/prune-webhook-payloads", () => {
  it("returns 401 and touches nothing when unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("skips when the lock is not acquired", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(await res.json()).toEqual({ skipped: "overlapping-run" });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("selects only terminal, aged, not-yet-erased rows, and BOUNDS the read", async () => {
    await GET(req());

    const eqs = db.state.filters.filter((f) => f.fn === "eq").map((f) => f.args);
    expect(eqs).toContainEqual(["payload_erased", false]);
    expect(eqs).toContainEqual(["suppressed", false]);
    // Terminal only: success OR failed-past-the-cap.
    const or = db.state.filters.find((f) => f.fn === "or");
    expect(String(or?.args[0])).toMatch(/status\.eq\.success/);
    expect(String(or?.args[0])).toMatch(/attempts\.gte\./);
    // Aged past the window, and below the confirmed-export watermark.
    const lts = db.state.filters.filter((f) => f.fn === "lt").map((f) => f.args[0]);
    expect(lts).toContain("created_at");
    expect(lts).toContain("updated_at");
    // The bound is not optional on this table: it is already over one page.
    expect(db.state.limitCalls[0]).toBeGreaterThan(0);
  });

  it("blanks payload and flags erased on exactly the confirmed ids; releases the lock", async () => {
    db.state.candidates = [
      { id: "w1", updated_at: "2026-01-01T00:00:00Z" },
      { id: "w2", updated_at: "2026-01-02T00:00:00Z" },
    ];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["w1", "w2"]));

    const res = await GET(req());
    const body = await res.json();

    expect(body.erased).toBe(2);
    expect(db.state.update).toMatchObject({ payload: {}, payload_erased: true });
    expect(db.state.updatedIds).toEqual(["w1", "w2"]);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_webhook_payloads", "lease");
  });

  it("leaves a row the warehouse holds only at an older version alone", async () => {
    db.state.candidates = [
      { id: "w1", updated_at: "2026-01-01T00:00:00Z" },
      { id: "w2", updated_at: "2026-01-02T00:00:00Z" },
    ];
    sf.executeStatement.mockResolvedValue({
      data: [
        ["w1", "true", "true"],
        ["w2", "true", "false"],
      ],
    });
    const res = await GET(req());
    expect((await res.json()).erased).toBe(1);
    expect(db.state.updatedIds).toEqual(["w1"]);
  });

  it("returns 500 and blanks NOTHING when the warehouse confirms none of the candidates", async () => {
    db.state.candidates = [{ id: "w1", updated_at: "2026-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["w1"], { present: false, current: false }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/confirmed NONE/);
    expect(db.state.update).toBeNull();
  });

  it("skips (blanks nothing) when the Snowflake mirror is not ready (#1118, export-gate)", async () => {
    gate.mirrorReadyForDeletion.mockResolvedValue({ ready: false, reason: "drift" });
    const res = await GET(req());
    expect((await res.json()).skipped).toBe("mirror-not-ready");
    expect(db.state.update).toBeNull();
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_webhook_payloads", "lease");
  });

  it("returns 500 and still releases the lock when the update errors (fail loud)", async () => {
    db.state.candidates = [{ id: "w1", updated_at: "2026-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["w1"]));
    db.state.updateError = { message: "boom" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_webhook_payloads", "lease");
  });
});
