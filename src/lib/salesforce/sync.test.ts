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

// #2071: the sync now makes a hire bookable through the same gated service the
// admin toggle uses. Mocked for the whole file, because the fixtures above have
// an agent whose stored attributes are {} and whose Salesforce record carries a
// tier, which is exactly the transition that flips, and the real service would
// probe Google.
const bookable = vi.hoisted(() => ({
  applyBookableByUserId: vi.fn(
    async (userId: string): Promise<{ status: string; userId: string; bookable?: boolean; reason?: string }> => ({
      status: "applied",
      userId,
      bookable: true,
    }),
  ),
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async (_entry: Record<string, unknown>) => {}) }));
vi.mock("@/lib/bookable/service", () => bookable);
vi.mock("@/lib/audit", () => audit);

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
      if (q.includes("IsActive = true AND Email != null AND (")) {
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
        if (q.includes("IsActive = true AND Email != null AND (")) {
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
        if (q.includes("IsActive = true AND Email != null AND (")) {
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
        if (q.includes("IsActive = true AND Email != null AND (")) {
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
        if (q.includes("IsActive = true AND Email != null AND (")) {
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
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.debtTeam);
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

// #1653: the manager of record must be refused when the picklist name answers to
// more than one Salesforce user.
//
// The planner's own rules are pinned offline (scripts/test-salesforce-manager-link.ts).
// What is proved HERE is the wiring: that the sync refuses rather than taking the
// first match, that it says WHICH refusal it made, that it never hands an ambiguous
// name to the looser fallback matcher, that an existing correct link is not
// disturbed, and that a second run over the same data writes nothing. The last one
// is not a nicety: this is an hourly job, so "assume it runs twice" is the default.
describe("manager name ambiguity (#1653)", () => {
  /** Every manager_id write this run made, with the rows it targeted. */
  const managerWrites = () =>
    store.calls
      .filter((c) => c.op === "update" && "manager_id" in (c.payload as object))
      .map((c) => ({
        managerId: (c.payload as { manager_id: string | null }).manager_id,
        ids: c.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2],
      }));

  let sentQueries: string[] = [];
  const soqlSent = () => sentQueries.slice();

  /**
   * Drives the sync with a Slate roster and whatever Salesforce answers. The two
   * name queries are told apart by `LastName IN (` FIRST: the fallback query's
   * text contains the exact query's `Name IN (` as a substring, so testing for the
   * exact one first would answer both with the same records and hide the very
   * hand-off this suite is about.
   */
  function arrange(opts: {
    roster: Record<string, unknown>[];
    existing?: Record<string, unknown>[];
    debtTeam: Record<string, unknown>[];
    byName?: Record<string, unknown>[];
    byLastName?: Record<string, unknown>[];
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
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(opts.debtTeam);
      if (q.includes("LastName IN (")) return sfResponse(opts.byLastName ?? []);
      if (q.includes("Name IN (")) return sfResponse(opts.byName ?? []);
      return sfResponse([]);
    });
  }

  const agentRow = (over: Record<string, unknown> = {}) => ({
    id: "u1",
    email: "a@x.com",
    manager_id: null,
    role: "agent",
    salesforce_user_id: null,
    ...over,
  });

  it("links NOTHING when the picklist name answers to two Salesforce users", async () => {
    arrange({
      roster: [
        agentRow(),
        { id: "u3", email: "mona1@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    // The defect: the old code kept the FIRST match, so u1 was linked to mona1
    // and nothing anywhere said a second person answered to the same name.
    expect(managerWrites()).toHaveLength(0);
    expect(result.managersLinked).toBe(0);
    expect(result.managersAmbiguous).toBe(1);
    // Many matches is a refusal in its own right, never reported as absence (L11).
    expect(result.managersUnresolved).toBe(0);
    // And no manager user is invented for either of them, which would leave a
    // half-made row behind for a name the sync just refused.
    const managerInserts = store.calls.filter(
      (c) => c.op === "insert" && JSON.stringify(c.payload).includes("mona"),
    );
    expect(managerInserts).toHaveLength(0);
  });

  it("reports a name that matched NOBODY differently from one that matched several", async () => {
    arrange({
      roster: [agentRow()],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Nobody Matching", HighDebt__c: true },
      ],
      byName: [],
      byLastName: [],
    });

    const result = await syncSalesforceAgents();

    expect(result.managersUnresolved).toBe(1);
    expect(result.managersAmbiguous).toBe(0);
    expect(managerWrites()).toHaveLength(0);
  });

  it("does NOT hand an ambiguous name to the looser fallback matcher (L75)", async () => {
    arrange({
      roster: [agentRow()],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
      // If the ambiguous name reached the fallback, this ONE candidate would
      // resolve it and the refusal would be quietly overturned by a weaker match.
      byLastName: [
        { Id: "005M3", FirstName: "Mona", LastName: "Manager", Email: "mona3@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    const lastNameQuery = soqlSent().find((q) => q.includes("LastName IN ("));
    expect(lastNameQuery).toBeUndefined();
    expect(result.managersLinked).toBe(0);
    expect(result.managersAmbiguous).toBe(1);
    expect(JSON.stringify(store.calls)).not.toContain("mona3@x.com");
  });

  it("leaves an EXISTING correct link exactly as it is when the name goes ambiguous", async () => {
    arrange({
      roster: [
        agentRow({ manager_id: "u3" }),
        { id: "u3", email: "mona1@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
      ],
      existing: [
        { id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: null },
        { id: "u3", email: "mona1@x.com", attributes: {}, salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    // Neither re-pointed nor cleared. "We could not work out who this is" must
    // never be written down as "this person has no manager" (#1474).
    expect(managerWrites()).toHaveLength(0);
    expect(result.managersUnlinked).toBe(0);
    expect(result.managersAmbiguous).toBe(1);
  });

  it("still links a name exactly one Salesforce user answers to", async () => {
    arrange({
      roster: [
        agentRow(),
        { id: "u3", email: "mona@x.com", manager_id: null, role: "manager", salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [{ Id: "005M1", Name: "Mona Manager", Email: "mona@x.com" }],
    });

    const result = await syncSalesforceAgents();

    const written = managerWrites().filter((w) => w.managerId === "u3");
    expect(written).toHaveLength(1);
    expect(written[0].ids).toEqual(["u1"]);
    expect(result.managersLinked).toBe(1);
    expect(result.managersAmbiguous).toBe(0);
  });

  it("writes NOTHING on a second run over the same ambiguous data (it runs hourly)", async () => {
    const arrangeAmbiguous = () =>
      arrange({
        // Deliberately UNLINKED. With the agent already pointed at one of the two
        // candidates, a regression to taking the first match writes nothing (the
        // link it would write is the one already there), so the test would pass
        // over the very defect it exists to catch.
        roster: [
          agentRow({ manager_id: null, salesforce_user_id: "005A" }),
          { id: "u3", email: "mona1@x.com", manager_id: null, role: "manager", salesforce_user_id: "005M1" },
        ],
        existing: [
          { id: "u1", email: "a@x.com", attributes: {}, salesforce_user_id: "005A" },
          { id: "u3", email: "mona1@x.com", attributes: {}, salesforce_user_id: "005M1" },
        ],
        debtTeam: [
          { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        ],
        byName: [
          { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
          { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
        ],
      });

    arrangeAmbiguous();
    const first = await syncSalesforceAgents();
    const firstWrites = managerWrites();

    arrangeAmbiguous();
    const second = await syncSalesforceAgents();

    expect(firstWrites).toHaveLength(0);
    expect(managerWrites()).toHaveLength(0);
    // Identical in and identical out: the second hour reports the same refusal
    // rather than converging on one of the two by accident.
    expect(second.managersAmbiguous).toBe(first.managersAmbiguous);
    expect(second.managersLinked).toBe(first.managersLinked);
    expect(second.managersUnlinked).toBe(first.managersUnlinked);
    expect(second.managersUnresolved).toBe(first.managersUnresolved);
  });

  it("counts EVERY agent under a shared name, not just the name", async () => {
    arrange({
      roster: [
        agentRow(),
        { id: "u2", email: "b@x.com", manager_id: null, role: "agent", salesforce_user_id: null },
      ],
      debtTeam: [
        { Id: "005A", Email: "a@x.com", Name: "Agent A", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
        { Id: "005B", Email: "b@x.com", Name: "Agent B", Agent_Manager__c: "Mona Manager", HighDebt__c: true },
      ],
      byName: [
        { Id: "005M1", Name: "Mona Manager", Email: "mona1@x.com" },
        { Id: "005M2", Name: "Mona Manager", Email: "mona2@x.com" },
      ],
    });

    const result = await syncSalesforceAgents();

    // The number that matters to a reader is how many PEOPLE have no settled
    // approver, which is not the number of duplicated picklist values.
    expect(result.managersAmbiguous).toBe(2);
  });
});

// #2071: how a hire becomes bookable. The rule is pinned in
// scripts/test-salesforce-onboarding.ts; this is the wiring: that the roster
// query admits the onboarding profiles, that the pending mark travels in the same
// write as the attributes, that the flip goes through the gated service and is
// recorded, and that a refusal leaves the mark for the next hour.
describe("a hire becomes bookable on the first tier or the Sales profile (#2071)", () => {
  const sfRoster = (records: unknown[]) => {
    sf.fetchSfWithRetry.mockImplementation(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", instance_url: "https://sf.example" }) };
      }
      const q = decodeURIComponent((url.split("q=")[1] ?? "").replace(/\+/g, " "));
      if (q.includes("IsActive = true AND Email != null AND (")) return sfResponse(records);
      return sfResponse([]);
    });
  };
  const rosterQuery = () => {
    const call = sf.fetchSfWithRetry.mock.calls
      .map((c) => decodeURIComponent(String(c[0]).split("q=")[1] ?? "").replace(/\+/g, " "))
      .find((q) => q.includes("FROM User WHERE IsActive"));
    return call ?? "";
  };

  beforeEach(() => {
    store.calls.length = 0;
    store.config.errorOn = undefined;
    store.config.existing = [];
    store.config.afterInsert = [];
    store.config.reapable = [];
    bookable.applyBookableByUserId.mockClear();
    bookable.applyBookableByUserId.mockImplementation(async (userId: string) => ({
      status: "applied",
      userId,
      bookable: true,
    }));
    audit.recordAudit.mockClear();
  });

  it("asks Salesforce for the Sales and Chatter Free profiles, not only for tiers", async () => {
    sfRoster([]);
    await syncSalesforceAgents();
    const q = rosterQuery();
    expect(q).toContain("Profile.Name IN ('Sales', 'Chatter Free User')");
    expect(q).toMatch(/OR .*LowDebt__c=true/);
  });

  it("creates a Chatter Free hire not bookable, with no flip owed, and counts them", async () => {
    sfRoster([{ Email: "new@x.com", Name: "New Hire", Profile: { Name: "Chatter Free User" } }]);
    store.config.afterInsert = [{ id: "u9", email: "new@x.com", manager_id: null, role: "agent" }];
    const result = await syncSalesforceAgents();
    const insert = store.calls.find((c) => c.op === "insert" && c.table === "users");
    const row = (insert?.payload as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ email: "new@x.com", role: "agent", bookable: false });
    expect(row.bookable_pending_since).toBeUndefined();
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    expect(result.createdUntiered).toBe(1);
    expect(result.bookableFlipped).toEqual([]);
  });

  it("flips a hire whose first tier just arrived, marks them pending in the same write, and records who did it", async () => {
    store.config.existing = [
      { id: "u1", email: "hire@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "hire@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "hire@x.com", Name: "Hire", Profile: { Name: "Sales" }, LowDebt__c: true, AchieveBackendServicer__c: true }]);

    const result = await syncSalesforceAgents();

    const upsert = store.calls.find((c) => c.op === "upsert");
    const row = (upsert?.payload as Record<string, unknown>[])[0];
    expect(row.attributes).toMatchObject({ role: "Sales", debt_team: ["low"] });
    expect(typeof row.bookable_pending_since).toBe("string");

    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u1", true);
    expect(audit.recordAudit).toHaveBeenCalledTimes(1);
    const entry = audit.recordAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({ actorId: null, action: "agent.bookable", targetUserId: "u1" });
    expect(entry.details).toMatchObject({ via: "salesforce-sync", reason: "first-tier", debt_team: ["low"] });
    expect(result.bookableFlipped).toEqual(["hire@x.com"]);
    expect(result.bookablePending).toEqual([]);
  });

  it("leaves a refused flip pending and records nothing, so next hour retries it", async () => {
    store.config.existing = [
      { id: "u1", email: "hire@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "hire@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "hire@x.com", Name: "Hire", Profile: { Name: "Sales" } }]);
    bookable.applyBookableByUserId.mockResolvedValueOnce({ status: "blocked", userId: "u1", reason: "google_not_provisioned" });

    const result = await syncSalesforceAgents();

    expect(result.bookablePending).toEqual(["hire@x.com"]);
    expect(result.bookableFlipped).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
    // The mark went out with the attributes, before the attempt, so it survives.
    const upsert = store.calls.find((c) => c.op === "upsert");
    expect(typeof (upsert?.payload as Record<string, unknown>[])[0].bookable_pending_since).toBe("string");
  });

  it("retries a pending flip even when nothing about the attributes changed", async () => {
    store.config.existing = [
      { id: "u1", email: "hire@x.com", attributes: { role: "Sales", debt_team: ["low"] }, bookable: false, deactivated_at: null, bookable_pending_since: "2026-09-08T10:00:00Z" },
    ];
    store.config.afterInsert = [{ id: "u1", email: "hire@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "hire@x.com", Name: "Hire", Profile: { Name: "Sales" }, LowDebt__c: true }]);

    const result = await syncSalesforceAgents();

    expect(bookable.applyBookableByUserId).toHaveBeenCalledWith("u1", true);
    expect(result.bookableFlipped).toEqual(["hire@x.com"]);
    const entry = audit.recordAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.details).toMatchObject({ reason: "retry" });
  });

  it("never overturns a person's hold: tiers against tiers is not a transition", async () => {
    // rvillar on 2026-09-08: a manager holding tiers, set non-bookable by hand.
    store.config.existing = [
      { id: "u1", email: "mgr@x.com", attributes: { role: "Sales Manager", debt_team: ["medium", "high"] }, bookable: false, deactivated_at: null, bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "mgr@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "mgr@x.com", Name: "Mgr", Profile: { Name: "Sales Manager" }, MediumDebt__c: true, HighDebt__c: true }]);

    const result = await syncSalesforceAgents();

    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
    expect(result.bookableFlipped).toEqual([]);
    const upsert = store.calls.find((c) => c.op === "upsert");
    expect((upsert?.payload as Record<string, unknown>[])[0].bookable_pending_since).toBeUndefined();
  });

  it("never puts somebody who has left back in the pool because of a Salesforce edit", async () => {
    store.config.existing = [
      { id: "u1", email: "gone@x.com", attributes: { role: "Chatter Free User" }, bookable: false, deactivated_at: "2026-08-24T00:00:00Z", bookable_pending_since: null },
    ];
    store.config.afterInsert = [{ id: "u1", email: "gone@x.com", manager_id: null, role: "agent" }];
    sfRoster([{ Email: "gone@x.com", Name: "Gone", Profile: { Name: "Sales" }, LowDebt__c: true }]);

    await syncSalesforceAgents();
    expect(bookable.applyBookableByUserId).not.toHaveBeenCalled();
  });
});
