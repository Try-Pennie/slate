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

// #1587: the shared cross system rep key, salesforce_user_id on users.
//
// The planner's own rules are pinned offline (scripts/test-salesforce-user-id-link.ts).
// What is proved HERE is the wiring: that the sync asks Salesforce for the Id at
// all, that it writes only what the plan says to write, that the write is fail
// loud, and that a second run over unchanged data writes nothing. The last one is
// not a nicety: this is an hourly job, so "assume it runs twice" is the default
// case, not the edge.
describe("salesforce_user_id linking (#1587)", () => {
  const SF_A = "005AAAAAAAAAAAAAAA";
  const SF_B = "005BBBBBBBBBBBBBBB";

  /** Just the upserts that carry a Salesforce id (not the agent attribute refresh). */
  const idWrites = () =>
    store.calls
      .filter((c) => c.op === "upsert")
      .flatMap((c) => (c.payload as Record<string, unknown>[]) ?? [])
      .filter((row) => "salesforce_user_id" in row);

  /** Every SOQL statement this run sent, decoded. */
  const soqlSent = () => sentQueries.slice();
  let sentQueries: string[] = [];

  /**
   * Drives the sync with one Slate roster row and whatever Salesforce answers.
   * `debtTeam` is what the main agent query returns; `byEmail` is what the
   * roster-remainder query returns for rows the first one missed.
   */
  function arrange(opts: {
    roster: Record<string, unknown>[];
    existing?: Record<string, unknown>[];
    debtTeam: Record<string, unknown>[];
    byEmail?: Record<string, unknown>[];
  }) {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    sentQueries = [];
    store.config.existing = opts.existing ?? [];
    store.config.afterInsert = opts.roster;
    store.config.reapable = [];
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }),
        };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      sentQueries.push(q);
      if (q.includes("IsActive = true AND (")) return sfResponse(opts.debtTeam);
      if (q.includes("IsActive = true AND Email != null AND Email IN")) {
        return sfResponse(opts.byEmail ?? []);
      }
      return sfResponse([]);
    });
  }

  it("asks Salesforce for the Id and writes it onto the roster row", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });

    const result = await syncSalesforceAgents();

    // The query has to ASK for the field. Without this the whole feature is a
    // planner that is only ever handed empty candidates, and every assertion below
    // would still pass on an empty plan.
    expect(soqlSent().some((q) => q.startsWith("SELECT Id,"))).toBe(true);

    const written = idWrites();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ id: "u1", salesforce_user_id: SF_A });
    // org_id and email ride along because they are the NOT NULL columns without a
    // default; the upsert's phantom insert tuple is invalid without them.
    expect(written[0]).toHaveProperty("org_id", "org1");
    expect(written[0]).toHaveProperty("email", "a@x.com");
    expect(result.salesforceIdsLinked).toBe(1);
    expect(result.salesforceIdsUnresolved).toBe(0);
  });

  it("writes NOTHING on a second run over the same data (it runs hourly)", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: SF_A }],
      existing: [{ id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: SF_A }],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    expect(result.salesforceIdsLinked).toBe(0);
    // And nothing is dressed up as a problem either: an id agreeing with itself is
    // the healthy state, not a disagreement and not an absence.
    expect(result.salesforceIdDisagreements).toBe(0);
    expect(result.salesforceIdsUnresolved).toBe(0);
  });

  it("REPORTS a disagreement and does not overwrite the stored id", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: SF_A }],
      existing: [{ id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: SF_A }],
      debtTeam: [{ Id: SF_B, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    // Nothing anywhere in this run may carry the new id. Checking only the id
    // writes would miss it being smuggled in on the attribute refresh upsert.
    expect(JSON.stringify(store.calls)).not.toContain(SF_B);
    expect(result.salesforceIdDisagreements).toBe(1);
    expect(result.salesforceIdsLinked).toBe(0);
  });

  it("stores NO id when two Salesforce users share the matching key, and reports it", async () => {
    arrange({
      roster: [{ id: "u1", email: "shared@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [
        { Id: SF_A, Email: "shared@x.com", Name: "Agent A", HighDebt__c: true },
        { Id: SF_B, Email: "shared@x.com", Name: "Agent A Duplicate", HighDebt__c: true },
      ],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    expect(result.salesforceIdAmbiguous).toBe(1);
    // Many matches is a refusal in its own right, never reported as absence (L521).
    expect(result.salesforceIdsUnresolved).toBe(0);
    expect(result.salesforceIdsLinked).toBe(0);
  });

  it("reports an agent it could not resolve rather than silently skipping them", async () => {
    arrange({
      roster: [{ id: "u1", email: "ghost@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [],
      byEmail: [],
    });

    const result = await syncSalesforceAgents();

    expect(idWrites()).toHaveLength(0);
    expect(result.salesforceIdsUnresolved).toBe(1);
  });

  it("backfills a roster row the debt-team query never returns", async () => {
    // The measured case: on 2026-08-31 the debt team query resolved 104 of 118
    // active users, and the other 14 (managers, admins, the team lead) are
    // reachable only through the by-email remainder query.
    arrange({
      roster: [
        { id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
        { id: "u9", email: "boss@x.com", manager_id: null, role: "admin", salesforce_user_id: null },
      ],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
      byEmail: [{ Id: SF_B, Email: "boss@x.com" }],
    });

    const result = await syncSalesforceAgents();

    const written = idWrites();
    expect(written).toHaveLength(2);
    expect(written.find((w) => w.id === "u9")).toMatchObject({ salesforce_user_id: SF_B });
    expect(result.salesforceIdsLinked).toBe(2);
    expect(result.salesforceIdsUnresolved).toBe(0);
    // The remainder query asks about the row the first query missed, and ONLY that
    // row: re-asking about one already answered would spend a Salesforce call per
    // hour forever on a question that is already settled.
    const remainder = soqlSent().find((q) => q.includes("Email != null AND Email IN"));
    expect(remainder).toContain("boss@x.com");
    expect(remainder).not.toContain("a@x.com");
  });

  it("throws when the id write errors (fail loud, never a quiet non-link)", async () => {
    arrange({
      roster: [{ id: "u1", email: "a@x.com", manager_id: null, role: "agent", salesforce_user_id: null }],
      debtTeam: [{ Id: SF_A, Email: "a@x.com", Name: "Agent A", HighDebt__c: true }],
    });
    // `existing` is empty, so the agent arrives as an INSERT and this run's only
    // upsert is the id write itself.
    store.config.errorOn = "upsert";

    await expect(syncSalesforceAgents()).rejects.toThrow(/user id link batch failed/);
  });
});
