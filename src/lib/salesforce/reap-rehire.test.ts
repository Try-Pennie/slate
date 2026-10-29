import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #2386, end to end: what happens to somebody the Salesforce reap departs and an
 * admin later reactivates.
 *
 * The two halves live in different modules and each already has its own suite
 * against its own fake, which is exactly why neither could see this: the reap's
 * write and the reactivation's write are correct on their own and the HARM is the
 * state one leaves for the other. So this file gives both real code paths ONE
 * in memory `users` table and then asks the SHIPPED pool predicate (`isRoutable`,
 * the same one `resolveBucketPool` mirrors) whether the person is routable. Nothing
 * here re-implements that rule (L70).
 *
 * The scenario: Salesforce marks agent X inactive, the hourly reap departs them, a
 * month later they are rehired and an admin presses Reactivate. Under the code this
 * file was written against, X is back in the routing pool that instant with no
 * reachability probe, no pool entry bootstrap and an empty availability cache,
 * because `bookable` was never cleared on the way out and reactivation only clears
 * `deactivated_at`.
 */

const provision = vi.hoisted(() => ({
  ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })),
}));
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/env", () => ({
  sfClientId: () => "cid",
  sfClientSecret: () => "sec",
  sfInstanceUrl: () => "https://sf.example",
  googleHostedDomain: () => "trypennie.com",
}));

const sf = vi.hoisted(() => ({ fetchSfWithRetry: vi.fn() }));
vi.mock("@/lib/salesforce/retry", () => sf);

/**
 * ONE `users` table, shared by the roster sync and the offboarding service.
 *
 * Both reach it through `@/lib/supabase/admin`, so one mock serves both, and that
 * sharing is the point: a fake per module would let each half pass while the state
 * they hand each other is wrong, which is the state this file exists to catch.
 */
const store = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const users = new Map<string, Row>();
  /** Refuse the deactivating write, to drive the failure path. */
  const config: { failDeactivationWrite: boolean } = { failDeactivationWrite: false };

  function seed(rows: Row[]) {
    users.clear();
    // The column's NOT NULL DEFAULT false (#4200), so a read narrowed by it matches
    // a row the fixture did not spell it on, as the database would.
    for (const row of rows) users.set(String(row.id), { is_placeholder: false, ...row });
  }

  type Filter = [kind: "eq" | "in" | "is" | "not", col: string, val: unknown];

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every(([kind, col, val]) => {
      const current = row[col] ?? null;
      if (kind === "eq") return current === val;
      if (kind === "in") return Array.isArray(val) && val.includes(current);
      if (kind === "is") return current === val;
      // `.not(col, "is", null)` is the only negated filter either path uses.
      if (kind === "not") return current !== val;
      return true;
    });
  }

  function makeDb() {
    return {
      from(table: string) {
        // `returning` is a `.select()` chained AFTER a write, which PostgREST answers
        // with the rows the write changed (#2085: the routable write reads what it
        // wrote from the same statement).
        const state: { op?: string; payload?: unknown; filters: Filter[]; returning?: boolean } = {
          filters: [],
        };
        const rowsNow = () => [...users.values()].filter((r) => matches(r, state.filters));

        function applyWrite(): { data: unknown; error: unknown } {
          if (table !== "users") return { data: null, error: null };
          if (state.op === "upsert" || state.op === "insert") {
            const rows = (Array.isArray(state.payload) ? state.payload : [state.payload]) as Row[];
            for (const row of rows) {
              const id = String(row.id ?? `generated-${users.size + 1}`);
              const stored = users.get(id);
              users.set(id, stored ? { ...stored, ...row, id } : { ...row, id });
            }
            return { data: null, error: null };
          }
          const patch = state.payload as Row;
          if (config.failDeactivationWrite && "deactivated_at" in patch && patch.deactivated_at) {
            // A refused statement writes NOTHING, so a test asserting what
            // survived a refusal is reading the database's real answer.
            return { data: null, error: { message: "permission denied for table users" } };
          }
          const hit = rowsNow();
          const written = hit.map((row) => ({ ...row, ...patch }));
          for (const row of written) users.set(String(row.id), row);
          return { data: written, error: null };
        }

        const builder = {
          select(_cols: string) {
            if (state.op === undefined) state.op = "select";
            else state.returning = true;
            return builder;
          },
          upsert(payload: unknown) {
            state.op = "upsert";
            state.payload = payload;
            return builder;
          },
          insert(payload: unknown) {
            state.op = "insert";
            state.payload = payload;
            return builder;
          },
          update(payload: unknown) {
            state.op = "update";
            state.payload = payload;
            return builder;
          },
          eq(col: string, val: unknown) {
            state.filters.push(["eq", col, val]);
            return builder;
          },
          in(col: string, val: unknown) {
            state.filters.push(["in", col, val]);
            return builder;
          },
          is(col: string, val: unknown) {
            state.filters.push(["is", col, val]);
            return builder;
          },
          not(col: string, _op: string, val: unknown) {
            state.filters.push(["not", col, val]);
            return builder;
          },
          async maybeSingle() {
            if (state.op === "select") {
              const hit = rowsNow();
              return { data: hit[0] ?? null, error: null };
            }
            const written = applyWrite();
            const rows = written.data as unknown[] | null;
            return { data: rows?.[0] ?? null, error: written.error };
          },
          then(
            resolve: (v: { data: unknown; error: unknown }) => unknown,
            reject?: (e: unknown) => unknown,
          ) {
            const result =
              state.op === "select"
                ? { data: rowsNow(), error: null }
                : applyWrite();
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }
  return { users, config, makeDb, seed };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => store.makeDb() }));

// The activation gate itself. Never reached in this scenario (that is the whole
// finding), so it stands in as a recorder of whether it was consulted.
const bookable = vi.hoisted(() => ({
  applyBookableByUserId: vi.fn(async (userId: string) => ({
    status: "applied",
    userId,
    bookable: true,
  })),
}));
vi.mock("@/lib/bookable/service", () => bookable);
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
// #2085: both writes here now record Regal's bookable trait. What reaches Regal is
// pinned in src/lib/bookable/routable-write.test.ts and emit.test.ts; this file is
// about the state the two writes leave each other, so the delivery is a recorder.
const emitted = vi.hoisted(() => ({ emitWebhook: vi.fn(async () => {}) }));
vi.mock("@/lib/webhooks/emit", () => emitted);
vi.mock("@/lib/booking/service", () => ({ startBulkReassign: vi.fn() }));

const sessions = vi.hoisted(() => ({
  revokeSupabaseSessions: vi.fn(async () => "no-auth-account"),
  restoreSupabaseSessions: vi.fn(async () => "no-auth-account"),
}));
vi.mock("@/lib/auth/session-revoke", () => sessions);

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({
  log: { error: vi.fn(), warn: logWarn, info: vi.fn() },
}));

import { syncSalesforceAgents } from "@/lib/salesforce/sync";
import { applyLifecycleByUserId } from "@/lib/offboarding/service";
import { isRoutable } from "@/lib/routing/staffing-depth";

const AGENT = {
  id: "u-rehire",
  org_id: "org1",
  email: "x@trypennie.com",
  role: "agent",
  attributes: { role: "Sales", debt_team: ["low"] },
  salesforce_user_id: "005OLD",
  auth_user_id: null,
  manager_id: null,
  bookable: true,
  deactivated_at: null,
  bookable_pending_since: null,
  is_test: false,
};

/** Salesforce reports the address INACTIVE and returns nobody in the roster, which
 *  is a departure and the reap's whole trigger. */
function salesforceHasDeparted() {
  sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
    if (url.includes("oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
    }
    const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
    if (q.includes("IsActive FROM User WHERE Email IN")) {
      return {
        ok: true,
        json: async () => ({
          records: [{ Id: "005OLD", Email: AGENT.email, IsActive: false }],
          done: true,
        }),
      };
    }
    return { ok: true, json: async () => ({ records: [], done: true }) };
  });
}

const stored = () => store.users.get(AGENT.id) as {
  bookable: boolean;
  deactivated_at: string | null;
};

beforeEach(() => {
  store.seed([{ ...AGENT }]);
  store.config.failDeactivationWrite = false;
  bookable.applyBookableByUserId.mockClear();
  logWarn.mockClear();
  salesforceHasDeparted();
});

describe("a leaver the Salesforce reap departed, then rehired (#2386)", () => {
  it("is not routable the moment an admin reactivates them", async () => {
    const run = await syncSalesforceAgents();
    expect(run.deactivated).toBe(1);
    // Departed: out of the pool on both columns, so every COUNT of the bookable
    // pool is right without each reader remembering to filter on two of them.
    expect(stored().deactivated_at).toEqual(expect.any(String));
    expect(stored().bookable).toBe(false);
    expect(isRoutable(stored())).toBe(false);

    // A month later. The admin agent page reactivates through this exact call.
    const res = await applyLifecycleByUserId(AGENT.id, "reactivate");
    expect(res).toMatchObject({ status: "applied", deactivate: false });

    // The finding. `deactivated_at` is clear, and they must still NOT be routable:
    // re-entry to the pool is the activation gate's decision, and it has not run.
    expect(stored().deactivated_at).toBeNull();
    expect(isRoutable(stored())).toBe(false);
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();

    // And the gate is what lets them back in, so the route out of this state is a
    // real one rather than a row only SQL can repair (L111).
    store.users.set(AGENT.id, { ...store.users.get(AGENT.id)!, bookable: true });
    expect(isRoutable(stored())).toBe(true);
  });

  it("clears a stale bookable on reactivate and says so, rather than repairing in silence", async () => {
    // A row left behind by the reap as it was BEFORE this change: departed, and
    // still carrying the flag. Reactivating it must not hand the pool somebody the
    // gate never looked at.
    store.seed([{ ...AGENT, bookable: true, deactivated_at: "2026-08-01T00:00:00.000Z" }]);

    const res = await applyLifecycleByUserId(AGENT.id, "reactivate");

    expect(res).toMatchObject({ status: "applied", clearedStaleBookable: true });
    expect(stored().bookable).toBe(false);
    expect(isRoutable(stored())).toBe(false);
    expect(logWarn).toHaveBeenCalledWith(
      "offboarding",
      expect.objectContaining({ user_id: AGENT.id }),
    );
  });

  it("says nothing when the reactivated row was already out of the pool", async () => {
    store.seed([{ ...AGENT, bookable: false, deactivated_at: "2026-08-01T00:00:00.000Z" }]);

    const res = await applyLifecycleByUserId(AGENT.id, "reactivate");

    expect(res).toMatchObject({ status: "applied" });
    expect((res as { clearedStaleBookable?: boolean }).clearedStaleBookable).toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });

  // The failure path. A refused deactivating write must never leave the person
  // half departed with nothing said: reporting `deactivated: 1` over a statement
  // the database refused is how a leaver goes on taking bookings while the lane
  // reports a clean hour (L12, L98).
  it("refuses to report a departure the database would not write", async () => {
    store.config.failDeactivationWrite = true;

    await expect(syncSalesforceAgents()).rejects.toThrow(/permission denied/);

    // Neither column moved, so nobody is half departed either.
    expect(stored().deactivated_at).toBeNull();
    expect(stored().bookable).toBe(true);
  });
});
