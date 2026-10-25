import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #4180: the reroute drill and the smoke canary both book on the two smoke test advisors, and on
// 2026-10-23 at 15:34 UTC they overlapped and both failed. One lease in `sync_locks` now keeps
// them apart. This drives the REAL lock code (`acquireLease`, `releaseLock`) and the REAL two
// routes that take it (`/api/smoke/demotion-drill` for the drill, `/api/smoke/test-advisor-lease`
// for the canary) over one in-memory `sync_locks` table, so what is pinned is the exclusion
// itself rather than a mock agreeing with our assumptions about it (L52):
//
//   - each side is refused while the other holds the lease, and gets it once released;
//   - a crashed holder's claim lapses after the TTL, and its stale release cannot free the claim
//     that replaced it;
//   - release is idempotent.
//
// The client half (polling up to a bound, not measured past it) is scripts/test-test-advisor-lease-wait.ts.

const env = vi.hoisted(() => ({ bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => "") }));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const drill = vi.hoisted(() => ({ runDemotionDrillLive: vi.fn() }));
vi.mock("@/lib/booking/demotion-drill-live", () => drill);

type Row = { key: string; claimed_at: string };
const table = vi.hoisted(() => ({ rows: [] as Row[] }));

/** Just enough of supabase-js over `sync_locks` for the lock code: insert on a primary key,
 *  a narrowed update and a narrowed delete, each answering the rows it touched. */
function syncLocks() {
  return {
    from(name: string) {
      if (name !== "sync_locks") throw new Error(`unexpected table ${name}`);
      const filters: ((r: Row) => boolean)[] = [];
      let op: { kind: "update"; patch: Partial<Row> } | { kind: "delete" } | null = null;
      const builder = {
        insert: async (row: Row) => {
          if (table.rows.some((r) => r.key === row.key)) return { error: { message: "duplicate key value" } };
          table.rows.push({ ...row });
          return { error: null };
        },
        update(patch: Partial<Row>) {
          op = { kind: "update", patch };
          return builder;
        },
        delete() {
          op = { kind: "delete" };
          return builder;
        },
        eq(col: keyof Row, val: string) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        lt(col: keyof Row, val: string) {
          filters.push((r) => r[col] < val);
          return builder;
        },
        async select() {
          const hit = table.rows.filter((r) => filters.every((f) => f(r)));
          if (op?.kind === "update") for (const r of hit) Object.assign(r, op.patch);
          if (op?.kind === "delete") table.rows = table.rows.filter((r) => !hit.includes(r));
          return { data: hit.map((r) => ({ key: r.key })), error: null };
        },
      };
      return builder;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => syncLocks() }));

import { POST as drillPost } from "@/app/api/smoke/demotion-drill/route";
import { POST as takePost, DELETE as releaseDelete } from "@/app/api/smoke/test-advisor-lease/route";
import { TEST_ADVISOR_LEASE_KEY, TEST_ADVISOR_LEASE_TTL_MS } from "@/lib/booking/test-advisor-lease-terms";

const AUTH = { authorization: "Bearer canary-key" };

async function runDrill() {
  const res = await drillPost(new Request("http://localhost/api/smoke/demotion-drill", { method: "POST", headers: AUTH }) as never);
  return (await res.json()) as { reason: string; detail: string };
}
async function canaryTake() {
  const res = await takePost(new Request("http://localhost/api/smoke/test-advisor-lease", { method: "POST", headers: AUTH }) as never);
  return { status: res.status, body: (await res.json()) as { outcome: string; token?: string } };
}
async function canaryRelease(token: string) {
  const res = await releaseDelete(
    new Request("http://localhost/api/smoke/test-advisor-lease", {
      method: "DELETE",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }) as never,
  );
  return { status: res.status, body: (await res.json()) as { outcome: string } };
}

const T0 = Date.parse("2026-10-23T15:34:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  table.rows = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) => (caller === "canary" && slot === "primary" ? "canary-key" : ""));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("one lease on the smoke test advisors (#4180)", () => {
  it("refuses the canary while the drill runs, and lets it in once the drill is done", async () => {
    let finishDrill!: (v: { reason: string; detail: string }) => void;
    drill.runDemotionDrillLive.mockImplementationOnce(() => new Promise((resolve) => (finishDrill = resolve)));
    const running = runDrill();
    await vi.waitFor(() => expect(drill.runDemotionDrillLive).toHaveBeenCalled());

    const whileDrilling = await canaryTake();
    expect(whileDrilling).toEqual({ status: 200, body: { outcome: "busy" } });

    finishDrill({ reason: "passed", detail: "ok" });
    expect(await running).toEqual({ reason: "passed", detail: "ok" });

    const after = await canaryTake();
    expect(after.body.outcome).toBe("held");
    expect(typeof after.body.token).toBe("string");
  });

  it("refuses the drill while the canary holds the lease, without running it, and runs it once released", async () => {
    const held = await canaryTake();
    expect(held.body.outcome).toBe("held");

    const refused = await runDrill();
    expect(refused.reason).toBe("test-advisors-held");
    expect(drill.runDemotionDrillLive).not.toHaveBeenCalled();
    // The drill's own one-at-a-time lock was handed back, so the next ask is not answered `busy`.
    expect(table.rows.map((r) => r.key)).toEqual([TEST_ADVISOR_LEASE_KEY]);

    expect((await canaryRelease(held.body.token!)).body.outcome).toBe("released");
    drill.runDemotionDrillLive.mockResolvedValueOnce({ reason: "passed", detail: "ok" });
    expect((await runDrill()).reason).toBe("passed");
    expect(table.rows).toEqual([]);
  });

  it("releases the drill's hold even when the drill throws past its own boundary", async () => {
    drill.runDemotionDrillLive.mockRejectedValueOnce(new Error("bucket read failed"));
    expect((await runDrill()).reason).toBe("errored");
    expect(table.rows).toEqual([]);
    expect((await canaryTake()).body.outcome).toBe("held");
  });

  it("lets a crashed holder's claim lapse after the TTL, and never before", async () => {
    const crashed = await canaryTake();
    expect(crashed.body.outcome).toBe("held");
    // The holder dies and never releases.

    vi.setSystemTime(T0 + TEST_ADVISOR_LEASE_TTL_MS - 1_000);
    expect((await runDrill()).reason).toBe("test-advisors-held");
    expect(drill.runDemotionDrillLive).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + TEST_ADVISOR_LEASE_TTL_MS + 1_000);
    const next = await canaryTake();
    expect(next.body.outcome).toBe("held");

    // The dead holder's late release must not free the claim that replaced it.
    expect((await canaryRelease(crashed.body.token!)).body.outcome).toBe("not-held");
    expect((await canaryTake()).body.outcome).toBe("busy");
  });

  it("releases idempotently: the second release answers not-held and changes nothing", async () => {
    const held = await canaryTake();
    expect((await canaryRelease(held.body.token!)).body).toEqual({ outcome: "released" });
    expect((await canaryRelease(held.body.token!)).body).toEqual({ outcome: "not-held" });
    expect(table.rows).toEqual([]);
    expect((await canaryTake()).body.outcome).toBe("held");
  });
});
