import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the prune-routing cron. Since #1102 it is VERIFY-GATED: it reads a
// bounded batch of aged routing_decisions and asks the warehouse, per id, whether
// it actually holds that row at a current version, then deletes ONLY the confirmed
// ids. The export watermark stays as a cheap pre-filter but can never withhold a
// candidate (a 12-month-old row is always below a watermark that is minutes old),
// so the read-back is the real gate.
//
// The REAL verifier runs here (only the Snowflake transport is stubbed), so this
// covers the whole path: candidate read, verification, delete-by-id, and the
// refusal when the warehouse confirms nothing.
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
  exportedThrough: vi.fn(async (): Promise<string | null> => "2026-07-28T00:00:00Z"),
}));
const sf = vi.hoisted(() => ({ executeStatement: vi.fn() }));
const db = vi.hoisted(() => {
  const state = {
    candidates: [] as { id: string; created_at: string }[],
    readError: null as { message: string } | null,
    deleteError: null as { message: string } | null,
    deletedIds: [] as string[],
    ltCalls: [] as Array<[string, string]>,
    limitCalls: [] as number[],
    orderCalls: [] as string[],
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.lt = (col: string, val: string) => {
    state.ltCalls.push([col, val]);
    return chain;
  };
  chain.order = (col: string) => {
    state.orderCalls.push(col);
    return chain;
  };
  chain.limit = (n: number) => {
    state.limitCalls.push(n);
    return Promise.resolve({ data: state.candidates, error: state.readError });
  };
  const del = () => ({
    in: (_col: string, ids: string[]) => {
      state.deletedIds = ids;
      return Promise.resolve({ error: state.deleteError, count: state.deleteError ? null : ids.length });
    },
  });
  const from = vi.fn(() => ({ ...chain, delete: del }));
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
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: hb.sendThrottledAlert,
  // #1151: the lane clears its "retention stopped" page once it gets past
  // the export gate, so the boundary has to exist here too.
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
vi.mock("@/lib/snowflake/reexport", () => ({ repairUnverified: rx.repairUnverified }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

/** Warehouse answer: present + current for each id unless overridden. */
const warehouseHolds = (ids: string[], opts: { present?: boolean; current?: boolean } = {}) => ({
  data: ids.map((id) => [id, String(opts.present ?? true), String(opts.current ?? true)]),
});

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  gate.mirrorReadyForDeletion.mockResolvedValue({ ready: true, reason: null });
  gate.exportedThrough.mockResolvedValue("2026-07-28T00:00:00Z");
  db.state.candidates = [];
  db.state.readError = null;
  db.state.deleteError = null;
  db.state.deletedIds = [];
  db.state.ltCalls = [];
  db.state.limitCalls = [];
  db.state.orderCalls = [];
});

describe("GET /api/cron/prune-routing (verify-gated, #1102)", () => {
  it("returns 401 and touches nothing when the request is unauthorized", async () => {
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

  it("skips without reading candidates when the mirror is not ready", async () => {
    gate.mirrorReadyForDeletion.mockResolvedValueOnce({ ready: false, reason: "mirror not configured" });
    const res = await GET(req());
    expect((await res.json()).skipped).toBe("mirror-not-ready");
    expect(gate.exportedThrough).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("skips when nothing has been exported yet", async () => {
    gate.exportedThrough.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect((await res.json()).skipped).toBe("nothing-exported-yet");
    expect(db.from).not.toHaveBeenCalled();
  });

  it("reads a BOUNDED, ordered batch with a ~12-month cutoff and a strict watermark bound", async () => {
    await GET(req());
    // Bounded: routing_decisions is a growth table, so an unbounded read would
    // silently see only one PostgREST page.
    expect(db.state.limitCalls[0]).toBeGreaterThan(0);
    expect(db.state.orderCalls[0]).toBe("created_at");

    const [[cutoffField, cutoffIso], [wmField, wmIso]] = db.state.ltCalls;
    expect(cutoffField).toBe("created_at");
    const elapsedMs = Date.now() - new Date(cutoffIso).getTime();
    expect(elapsedMs).toBeGreaterThan(11 * 30 * 24 * 60 * 60 * 1000);
    expect(elapsedMs).toBeLessThan(13 * 30 * 24 * 60 * 60 * 1000);
    // Strict `lt`, not `lte`: the export cursor is a composite (created_at, id)
    // keyset, so an equal-watermark row was not necessarily exported.
    expect(wmField).toBe("created_at");
    expect(wmIso).toBe("2026-07-28T00:00:00Z");
  });

  it("deletes exactly the ids the warehouse confirms, and reports the count", async () => {
    db.state.candidates = [
      { id: "r1", created_at: "2025-01-01T00:00:00Z" },
      { id: "r2", created_at: "2025-01-02T00:00:00Z" },
    ];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["r1", "r2"]));

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pruned).toBe(2);
    expect(body.candidates).toBe(2);
    expect(db.state.deletedIds).toEqual(["r1", "r2"]);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_routing", "lease");
  });

  it("leaves a row the warehouse does not hold in place, and deletes only the rest", async () => {
    db.state.candidates = [
      { id: "r1", created_at: "2025-01-01T00:00:00Z" },
      { id: "r2", created_at: "2025-01-02T00:00:00Z" },
    ];
    sf.executeStatement.mockResolvedValue({
      data: [
        ["r1", "true", "true"],
        ["r2", "false", "false"],
      ],
    });
    const res = await GET(req());
    expect((await res.json()).pruned).toBe(1);
    expect(db.state.deletedIds).toEqual(["r1"]);
  });

  it("returns 500 and deletes NOTHING when the warehouse confirms none of the candidates", async () => {
    // The watermark claimed these were archived. A quiet "0 pruned" here would be
    // indistinguishable from a day with no aged rows.
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["r1"], { present: false, current: false }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/confirmed NONE/);
    expect(db.state.deletedIds).toEqual([]);
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and deletes NOTHING when the warehouse read fails", async () => {
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockRejectedValue(new Error("warehouse suspended"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/warehouse suspended/);
    expect(db.state.deletedIds).toEqual([]);
  });

  it("succeeds with nothing pruned on a genuinely quiet day", async () => {
    db.state.candidates = [];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).pruned).toBe(0);
    expect(sf.executeStatement).not.toHaveBeenCalled();
  });

  it("returns 500 when the candidate read fails and still releases the lock", async () => {
    db.state.readError = { message: "db exploded" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("db exploded");
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });

  // #1102 observability. Before this, none of the three lanes stamped a heartbeat,
  // appeared in any bounds map, or sent an alert: a failing lane returned 500 into
  // a log with 7-day retention and nothing was watching.
  it("asks for a re-export of the rows the warehouse could not confirm (#1102 repair path)", async () => {
    // Without this the refusal is permanent: the export cursor is strictly forward,
    // so nothing else ever revisits a skipped row, and the #1100 backfill lane does
    // not exist. The lane would then fail every night with no way to fix it.
    db.state.candidates = [
      { id: "r1", created_at: "2025-01-01T00:00:00Z" },
      { id: "r2", created_at: "2025-01-02T00:00:00Z" },
    ];
    sf.executeStatement.mockResolvedValue({
      data: [
        ["r1", "true", "true"],
        ["r2", "false", "false"],
      ],
    });
    await GET(req());
    expect(rx.repairUnverified).toHaveBeenCalledWith("routing_decisions", ["r2"]);
    // ...and the confirmed row is still deleted in the same run.
    expect(db.state.deletedIds).toEqual(["r1"]);
  });

  it("does not ask for a re-export when every candidate verified", async () => {
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["r1"]));
    await GET(req());
    expect(rx.repairUnverified).not.toHaveBeenCalled();
  });

  it("stamps the dead-man's-switch heartbeat on a successful run", async () => {
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["r1"]));
    await GET(req());
    expect(hb.recordHeartbeat).toHaveBeenCalledWith("prune-routing");
  });

  it("does NOT stamp the heartbeat when the lane throws, so a nightly failure goes stale and pages", async () => {
    // This is the property that makes the dead-man's switch work at all. Stamping
    // in a finally block would make a lane that fails every night look alive.
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockRejectedValue(new Error("warehouse suspended"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(hb.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("alerts (and still stamps) when the mirror is not usable, since a skip is invisible otherwise", async () => {
    // A skip returns a cheerful 200. If the warehouse credential were removed, all
    // three lanes would no-op forever while reporting healthy: retention silently
    // stopped, which is a protective control failing open.
    gate.mirrorReadyForDeletion.mockResolvedValueOnce({ ready: false, reason: "mirror not configured" });
    await GET(req());
    expect(hb.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldownMs, text] = hb.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("retention_skipped:prune-routing");
    // Throttled at roughly a day: these lanes only run daily, so a shorter cooldown
    // would just re-post the same thing.
    expect(cooldownMs).toBeGreaterThan(12 * 60 * 60_000);
    expect(text).toMatch(/routing decisions/);
    expect(text).toMatch(/mirror not configured/);
    // Still stamps: the cron DID fire, which is a different question from whether
    // it did any work.
    expect(hb.recordHeartbeat).toHaveBeenCalledWith("prune-routing");
  });

  it("alerts when nothing has been exported yet", async () => {
    gate.exportedThrough.mockResolvedValueOnce(null);
    await GET(req());
    expect(hb.sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(String((hb.sendThrottledAlert.mock.calls[0] as unknown as unknown[])[2])).toMatch(/nothing exported yet/);
  });

  it("does not alert on a healthy run", async () => {
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["r1"]));
    await GET(req());
    expect(hb.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("returns 500 when the delete itself fails and still releases the lock", async () => {
    db.state.candidates = [{ id: "r1", created_at: "2025-01-01T00:00:00Z" }];
    sf.executeStatement.mockResolvedValue(warehouseHolds(["r1"]));
    db.state.deleteError = { message: "delete blew up" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("delete blew up");
    expect(locks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
