import { describe, it, expect, vi, beforeEach } from "vitest";

// #91: syncSalesforceAgents must write the roster in batched statements (one
// upsert for existing-agent refreshes, one grouped update per manager) instead
// of one round-trip per user, and the new batched writes must fail loud (throw)
// when the db returns an error rather than silently reporting success. This
// drives the real sync against a fake Salesforce HTTP layer and a fake db that
// records every operation.

const provision = vi.hoisted(() => ({
  ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })),
}));
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/env", () => ({
  sfClientId: () => "cid",
  sfClientSecret: () => "sec",
  sfInstanceUrl: () => "https://sf.example",
}));

const sf = vi.hoisted(() => ({ fetchSfWithRetry: vi.fn() }));
vi.mock("@/lib/salesforce/retry", () => sf);

const store = vi.hoisted(() => {
  type Call = {
    op: string;
    table: string;
    select?: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  };
  const calls: Call[] = [];
  const config: {
    existing: unknown[];
    afterInsert: unknown[];
    reapable: unknown[];
    errorOn?: string;
  } = { existing: [], afterInsert: [], reapable: [] };

  function makeDb() {
    return {
      from(table: string) {
        const state: {
          table: string;
          op?: string;
          select?: string;
          payload?: unknown;
          filters: [string, string, unknown][];
        } = { table, filters: [] };
        const builder = {
          select(cols: string) {
            state.op = "select";
            state.select = cols;
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
          then(
            resolve: (v: { data: unknown; error: unknown }) => unknown,
            reject?: (e: unknown) => unknown,
          ) {
            calls.push({
              op: state.op!,
              table: state.table,
              select: state.select,
              payload: state.payload,
              filters: state.filters,
            });
            let result: { data: unknown; error: unknown } = { data: null, error: null };
            if (config.errorOn && state.op === config.errorOn) {
              result = { data: null, error: { message: `boom-${state.op}` } };
            } else if (state.op === "select") {
              if (state.select?.includes("attributes")) result = { data: config.existing, error: null };
              else if (state.select?.includes("manager_id")) result = { data: config.afterInsert, error: null };
              else result = { data: config.reapable, error: null };
            }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }
  return { calls, config, makeDb, sfUsers: [] as unknown[], mgr: [] as unknown[] };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => store.makeDb() }));

import { syncSalesforceAgents } from "@/lib/salesforce/sync";

function sfResponse(records: unknown[]) {
  return { ok: true, json: async () => ({ records, done: true }) };
}

describe("syncSalesforceAgents batching + fail-loud (#91)", () => {
  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    // One agent already in Slate (a@x, gets an update), one new (b@x, insert).
    // Both report the same OOO approver, so their manager link must collapse to
    // a single grouped write.
    store.config.existing = [{ id: "u1", email: "a@x.com", attributes: {} }];
    store.config.afterInsert = [
      { id: "u1", email: "a@x.com", manager_id: null, role: "agent" },
      { id: "u2", email: "b@x.com", manager_id: null, role: "agent" },
      { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
    ];
    store.config.reapable = [];

    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND (")) {
        return sfResponse([
          { Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
          { Email: "b@x.com", Name: "Agent B", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        ]);
      }
      if (q.includes("Name IN (")) return sfResponse([{ Name: "Mona Manager", Email: "mona@x.com" }]);
      return sfResponse([]);
    });
  });

  it("writes existing agents as ONE upsert and links as ONE grouped update", async () => {
    const result = await syncSalesforceAgents();

    const upserts = store.calls.filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toHaveLength(1); // just a@x, batched not per-row

    // Both agents share manager u3, so exactly one update carries manager_id
    // and targets both agents in a single .in("id", [...]) statement.
    const linkUpdates = store.calls.filter(
      (c) => c.op === "update" && (c.payload as { manager_id?: string }).manager_id === "u3",
    );
    expect(linkUpdates).toHaveLength(1);
    const inFilter = linkUpdates[0].filters.find((f) => f[0] === "in" && f[1] === "id");
    expect(inFilter?.[2]).toEqual(["u1", "u2"]);

    expect(result).toMatchObject({ inserted: 1, updated: 1, managersLinked: 2, managersCreated: 1 });
  });

  it("throws when a batched agent-update write errors (fail loud, no fake success)", async () => {
    store.config.errorOn = "upsert";
    await expect(syncSalesforceAgents()).rejects.toThrow(/agent update batch failed/);
  });

  it("throws when a grouped manager-link write errors", async () => {
    store.config.errorOn = "update";
    await expect(syncSalesforceAgents()).rejects.toThrow(/manager link batch failed/);
  });

  // #963: the initial roster reads used to destructure `const { data } = ...`
  // and ignore `error`. On a real query error `existing` was null, the by-email
  // map was empty, and every Salesforce agent was treated as brand new (the #277
  // silent-failure class). Routing the reads through `unwrap` makes a read error
  // throw instead of silently corrupting the roster.
  it("throws when a roster read errors (fail loud, no phantom brand-new agents)", async () => {
    store.config.errorOn = "select";
    await expect(syncSalesforceAgents()).rejects.toThrow(/read failed/);
  });

  // #1474: the sync must CONVERGE on Salesforce, not accumulate.
  //
  // Both directions, because a sync that only ever adds looks correct in every test
  // that only ever adds. Two live rows proved the gap: a manager whose manager of
  // record was one of his own agents, and a row pointing at itself.
  describe("converges on Salesforce instead of accumulating (#1474)", () => {
    /** The manager_id values written by this run, one entry per update call. */
    const managerWrites = () =>
      store.calls
        .filter((c) => c.op === "update" && "manager_id" in (c.payload as object))
        .map((c) => ({
          managerId: (c.payload as { manager_id: string | null }).manager_id,
          ids: c.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2],
        }));

    it("clears a link when Salesforce no longer names a manager", async () => {
      // a@x is already linked to u3; Salesforce now names nobody for them.
      store.config.afterInsert = [
        { id: "u1", email: "a@x.com", manager_id: "u3", role: "agent" },
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
      ];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND (")) {
          return sfResponse([{ Email: "a@x.com", Name: "Agent A", Agent_Manager__c: null, HighDebt__c: true }]);
        }
        return sfResponse([]);
      });

      const result = await syncSalesforceAgents();

      const cleared = managerWrites().filter((w) => w.managerId === null);
      expect(cleared).toHaveLength(1);
      expect(cleared[0].ids).toEqual(["u1"]);
      expect(result.managersUnlinked).toBe(1);
      expect(result.managersLinked).toBe(0);
    });

    // The distinction the whole thing rests on. Salesforce NAMING a manager we
    // cannot resolve to a Slate user arrives as the same null email as naming
    // nobody, and only the second is grounds for clearing. Treating them alike
    // would delete a correct link every time a picklist name went ambiguous.
    it("does NOT clear when the manager name could not be resolved", async () => {
      store.config.afterInsert = [
        { id: "u1", email: "a@x.com", manager_id: "u3", role: "agent" },
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
      ];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND (")) {
          return sfResponse([
            { Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Nobody Matching", HighDebt__c: true },
          ]);
        }
        // The name lookup finds no candidate, so the resolver returns null.
        return sfResponse([]);
      });

      const result = await syncSalesforceAgents();

      expect(managerWrites().filter((w) => w.managerId === null)).toHaveLength(0);
      expect(result.managersUnlinked).toBe(0);
      // Counted, so a run that deliberately did nothing is visible as that rather
      // than as an agent who genuinely has no manager.
      expect(result.managersUnresolved).toBe(1);
    });

    it("writes nothing when the link is already null (a quiet hour is quiet)", async () => {
      store.config.afterInsert = [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent" }];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND (")) {
          return sfResponse([{ Email: "a@x.com", Name: "Agent A", Agent_Manager__c: null, HighDebt__c: true }]);
        }
        return sfResponse([]);
      });

      const result = await syncSalesforceAgents();

      expect(managerWrites()).toHaveLength(0);
      expect(result.managersUnlinked).toBe(0);
    });

    it("throws when the unlink write errors (fail loud, never a quiet non-clear)", async () => {
      store.config.afterInsert = [
        { id: "u1", email: "a@x.com", manager_id: "u3", role: "agent" },
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager" },
      ];
      sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
        if (url.includes("oauth2/token")) {
          return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
        }
        const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
        if (q.includes("IsActive = true AND (")) {
          return sfResponse([{ Email: "a@x.com", Name: "Agent A", Agent_Manager__c: null, HighDebt__c: true }]);
        }
        return sfResponse([]);
      });
      store.config.errorOn = "update";

      await expect(syncSalesforceAgents()).rejects.toThrow(/manager unlink batch failed/);
    });
  });
});
