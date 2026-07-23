import { describe, it, expect, vi, beforeEach } from "vitest";

// #1073: the prune-webhook-payloads cron blanks webhook_deliveries.payload (full
// attendee PII) on deliveries that are terminal (success, or failed past the
// retry cap) and older than the 90-day retention window, and sets payload_erased
// so no send path re-delivers the blanked row. This covers the route glue: auth
// guard, lock guard, the update SHAPE (only terminal + aged + not-already-erased
// rows, blanking payload and flagging), lock release, and the response.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));

// Chainable builder that records the update payload and every filter, and
// resolves to a canned { error, count } at the end of the chain.
const captured = vi.hoisted(() => ({
  update: null as Record<string, unknown> | null,
  filters: [] as { fn: string; args: unknown[] }[],
  result: { error: null as { message: string } | null, count: 0 as number | null },
}));
const builder = vi.hoisted(() => {
  const b: Record<string, unknown> = {};
  const record = (fn: string) => (...args: unknown[]) => {
    captured.filters.push({ fn, args });
    return b;
  };
  b.update = (vals: Record<string, unknown>) => {
    captured.update = vals;
    return b;
  };
  b.eq = record("eq");
  b.or = record("or");
  b.lt = record("lt");
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(captured.result).then(onF, onR);
  return b;
});
const from = vi.hoisted(() => vi.fn(() => builder));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  captured.update = null;
  captured.filters = [];
  captured.result = { error: null, count: 0 };
});

describe("GET /api/cron/prune-webhook-payloads", () => {
  it("returns 401 and touches nothing when unauthorized", async () => {
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

  it("blanks payload and flags erased on terminal, aged, not-yet-erased rows; releases the lock", async () => {
    captured.result = { error: null, count: 4 };
    const res = await GET(req());
    const body = await res.json();

    expect(body.erased).toBe(4);
    // The update blanks the PII payload and marks the row erased.
    expect(captured.update).toMatchObject({ payload: {}, payload_erased: true });

    const eqs = captured.filters.filter((f) => f.fn === "eq").map((f) => f.args);
    // Only rows not already erased, and never a suppressed row.
    expect(eqs).toContainEqual(["payload_erased", false]);
    expect(eqs).toContainEqual(["suppressed", false]);
    // Terminal only: success OR failed-past-the-cap (an OR filter).
    const or = captured.filters.find((f) => f.fn === "or");
    expect(String(or?.args[0])).toMatch(/status\.eq\.success/);
    expect(String(or?.args[0])).toMatch(/attempts\.gte\./);
    // Aged past the window (an lt on created_at).
    expect(captured.filters.some((f) => f.fn === "lt" && f.args[0] === "created_at")).toBe(true);

    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_webhook_payloads", "lease");
  });

  it("returns 500 and still releases the lock when the update errors (fail loud)", async () => {
    captured.result = { error: { message: "boom" }, count: null };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_prune_webhook_payloads", "lease");
  });
});
